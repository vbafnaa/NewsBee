"""Deduplication layer: collapse repeated events from any source into one story.

Events whose normalized titles match (same program at several branches, on several days,
or listed by several sources) become one Story with every occurrence kept, so the edition
never repeats an item. Stories are source-agnostic; future connectors feed the same layer.
"""

import hashlib
import re
from dataclasses import dataclass, field
from datetime import date

MAX_OCCURRENCES_SHOWN = 4
_NOISE = re.compile(r"[^a-z0-9]+")
_YEAR = re.compile(r",\s*\d{4}(?=,|$)")


@dataclass(frozen=True)
class Occurrence:
    source_id: str
    source_event_id: str
    event_date: str
    schedule_text: str
    venue: str
    room: str | None
    source_url: str


@dataclass
class Story:
    id: str
    title: str
    description: str | None
    occurrences: list[Occurrence] = field(default_factory=list)

    @property
    def first(self) -> Occurrence:
        return self.occurrences[0]

    @property
    def venues(self) -> list[str]:
        return list(dict.fromkeys(item.venue for item in self.occurrences))

    @property
    def recurring(self) -> bool:
        return len(self.occurrences) > 1


def story_key(title: str) -> str:
    return _NOISE.sub(" ", title.lower()).strip()


def collapse(events: list[dict]) -> list[Story]:
    """Snapshot events (dicts with source_id and facts) -> stories ordered by first date."""
    stories: dict[str, Story] = {}
    for event in events:
        facts = event["facts"]
        key = story_key(facts["title"])
        story = stories.get(key)
        if story is None:
            identity = hashlib.sha256(key.encode()).hexdigest()[:12]
            story = stories[key] = Story(identity, facts["title"], None)
        description = facts.get("description")
        if description and len(description) > len(story.description or ""):
            story.description = description
        occurrence = Occurrence(
            event["source_id"],
            facts["source_event_id"],
            facts["event_date"],
            facts["schedule_text"],
            facts["venue"],
            facts.get("room"),
            facts["source_url"],
        )
        if occurrence not in story.occurrences:
            story.occurrences.append(occurrence)
    for story in stories.values():
        story.occurrences.sort(key=lambda item: (item.event_date, item.schedule_text, item.venue))
    return sorted(stories.values(), key=lambda story: (story.first.event_date, story.title))


def _place(item: Occurrence) -> str:
    return item.venue + (f", {item.room}" if item.room else "")


def when_where(story: Story) -> str:
    """Fixed, factual When/Where text (never model-written)."""
    shown = story.occurrences[:MAX_OCCURRENCES_SHOWN]
    if len(story.occurrences) == 1:
        item = shown[0]
        return f"When: {_YEAR.sub('', item.schedule_text)}. Where: {_place(item)}."
    parts = [f"{_YEAR.sub('', item.schedule_text)} at {_place(item)}" for item in shown]
    more = len(story.occurrences) - len(shown)
    tail = f"; plus {more} more" if more else ""
    return f"When and where: {'; '.join(parts)}{tail}."


def week_label(start: str, end: str) -> str:
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    if first.month == last.month:
        return f"{first:%b} {first.day}\u2013{last.day}"
    return f"{first:%b} {first.day}\u2013{last:%b} {last.day}"
