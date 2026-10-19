"""Public meetings: the city or town council first, then other bodies; within each,
sooner meetings and then more substantive agenda items rank higher."""

import re
from collections.abc import Sequence

COUNCIL = re.compile(r"\b(city|town|village|borough|county|common) council\b|^council$", re.I)


def is_council(body: str) -> bool:
    return bool(COUNCIL.search(body))


def rank(stories: Sequence) -> list:
    def key(story):
        body = story.facts.get("body") or story.title
        return (
            not is_council(body),
            story.first.event_date,
            -int(story.facts.get("agenda_items") or 0),
            story.title,
        )

    return sorted(stories, key=key)
