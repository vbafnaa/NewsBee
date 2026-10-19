"""Turn public meeting records into plain-language facts a newsletter can summarise.

Platform connectors (Legistar, CivicClerk) hand over agenda items; this module keeps only
substantive ones (roll call, minutes, adjournment and similar steps are dropped, as are
private individuals' cases and benefits), picks the
most consequential first, and writes a description that opens with a rule-based sentence
saying what the public body does, so readers new to local government have context. The
story writer may only use facts from the title and description, so all context lives there.
"""

import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal

from projects.backend.modules.source_connectors.connectors.common import (
    EventFacts,
    plain_text,
    schedule_text,
)

MAX_ITEMS = 5
ITEM_MAX = 200
LEAD_MAX = 100
NOTE_MAX = 300
NO_VENUE = "Location listed in the agenda"

PROCEDURAL_START = re.compile(
    r"^(call(ed)? to order|roll call|pledge of allegiance|invocation|moment of silence|"
    r"land acknowledg|(approv|adopt|amend)\w*( of)?( the)?( draft)? (agenda|minutes)|"
    r"motion to .*\b(agenda|minutes|adjourn)|adjourn|"
    r"public (comment|forum|input|participation)s?\b)",
    re.I,
)
PROCEDURAL_ANY = re.compile(r"\bmeeting minutes\b|\bminutes of\b|^minutes\b|\bminutes$", re.I)
LEADING_MARKS = re.compile(r"^[^\w(\"'“‘$]+")
# Private individuals' cases and benefits: public record, but not newsletter material.
PRIVATE = re.compile(
    r"\((tenant|landlord|appellant|petitioner|respondent|claimant|grievant)\)|"
    r"security deposit case|effective date of benefit|retirement application|"
    r"disability retirement|personnel matter|workers'? compensation claim",
    re.I,
)
PROCEDURAL_WHOLE = re.compile(
    r"^((draft )?agenda|(draft )?minutes|public (comment|forum|input|participation)s?|"
    r"(verbal|written) comments|communications?|correspondence|consent (agenda|calendar)|"
    r"(new|old|unfinished|other) business|any other .*business|announcements?|"
    r"(staff |council |member |council member )?(reports?|comments)|[\w .'&-]* updates?"
    r"( \(.*\))?|closed session|executive session|recess|information/upcoming business|"
    r"[\w .&-]*['’]s reports?|(commissioner|board|member|council|committee|chair)s?"
    r"( member)?s? items|vote anticipated|opening( \(.*\))?)$",
    re.I,
)
BOILERPLATE = re.compile(r"reasonable accommodation|sign language|interpret", re.I)
LINK = re.compile(r"https?://\S+|www\.\S+", re.I)
CANCELLED = re.compile(r"cancel", re.I)
MEETING_SUFFIX = re.compile(
    r"[\s:-]*\b((regular|special|work session|study session)\s*)?meeting$", re.I
)

# (pattern on the body name, what the body does). First match wins.
ROLES = (
    (r"appeal|adjustment", "hears appeals and requests for exceptions to local rules"),
    (r"planning|zoning|land use", "reviews land-use, zoning and development proposals"),
    (r"school|education", "governs the local public schools"),
    (r"retirement|pension|budget|finance|audit|\btax", "oversees public money and finances"),
    (
        r"\b(city|town|village|common|borough|county) council$|^council$|"
        r"^board of (aldermen|selectmen|supervisors|county commissioners)$|select ?board|"
        r"^(village )?board of trustees$|^city commission$",
        "is the elected body that sets local laws, policies and the budget",
    ),
    (r"committee", "is a committee of the local government that studies specific matters"),
    (r"park|recreation", "advises on parks and recreation"),
    (r"housing", "works on local housing programs and policy"),
    (r"librar", "oversees the public library"),
    (r"transport|traffic|transit|mobility|street", "advises on streets, traffic and transit"),
    (r"environment|sustainab|energy|climate|electric", "works on energy and the environment"),
    (r"historic|preservation|landmark", "reviews changes to historic buildings and districts"),
    (r"police|public safety|fire", "advises on policing, fire and public safety"),
    (r"design|architect", "reviews the design of buildings and public spaces"),
    (r"\barts?\b|culture", "advises on public art and culture"),
)


class MeetingFacts(EventFacts):
    """A public meeting: an upcoming agenda (preview) or a recent one's recorded outcomes."""

    kind: Literal["meeting_preview", "meeting_outcome"]
    body: str


@dataclass(frozen=True)
class Item:
    title: str
    consent: bool = False
    weight: int = 0
    outcome: str | None = None


@dataclass(frozen=True)
class Meeting:
    source_event_id: str
    body: str
    start: date | datetime
    venue: str | None
    source_url: str
    items: list[Item]
    draft_agenda: bool = False
    minutes_final: bool = False
    note: str | None = None


def body_name(name: str) -> str:
    return MEETING_SUFFIX.sub("", " ".join(name.split())).strip(" -:") or name.strip()


def cancelled(*values: str | None) -> bool:
    return any(value and CANCELLED.search(value) for value in values)


def item_title(value: str | None) -> str | None:
    """Plain item title, or None for procedural steps, boilerplate and private matters."""
    text = plain_text(value, ITEM_MAX)
    if not text or len(value or "") > 4 * ITEM_MAX or BOILERPLATE.search(text):
        return None
    if PRIVATE.search(value or ""):
        return None
    text = LEADING_MARKS.sub("", text).rstrip(".")
    if not text:
        return None
    if any(p.search(text) for p in (PROCEDURAL_START, PROCEDURAL_WHOLE, PROCEDURAL_ANY)):
        return None
    return text


def select(items: list[Item]) -> list[Item]:
    """Distinct titles, most consequential first: non-consent, then weight, then agenda order."""
    best: dict[str, tuple[int, Item]] = {}
    for position, item in enumerate(items):
        key = item.title.casefold()
        if key not in best or item.weight > best[key][1].weight:
            best[key] = (best.get(key, (position,))[0], item)
    ranked = sorted(best.values(), key=lambda pair: (pair[1].consent, -pair[1].weight, pair[0]))
    return [item for _, item in ranked]


def context(body: str, place: str) -> str:
    for pattern, role in ROLES:
        if re.search(pattern, body, re.I):
            break
    else:
        role = f"is a public body of {place}'s local government"
    article = "" if body.lower().startswith("the ") else "The "
    return f"{article}{body} {role}."


def _lead(item: Item) -> str:
    if len(item.title) <= LEAD_MAX:
        return item.title
    return item.title[:LEAD_MAX].rsplit(" ", 1)[0].rstrip(",;:. ") + "..."


def _facts(meeting: Meeting, kind: str, title: str, description: str) -> MeetingFacts:
    return MeetingFacts(
        source_event_id=meeting.source_event_id,
        title=title,
        event_date=meeting.start.date().isoformat()
        if isinstance(meeting.start, datetime)
        else meeting.start.isoformat(),
        schedule_text=schedule_text(meeting.start, None),
        venue=" ".join((meeting.venue or "").split())[:ITEM_MAX] or NO_VENUE,
        source_url=meeting.source_url,
        description=plain_text(description),
        kind=kind,
        body=meeting.body,
    )


def _without_links(note: str) -> str:
    """Drop sentences that point at a link: the newsletter links the meeting page instead."""
    sentences = re.split(r"(?<=[.!?])\s+", " ".join(note.split()))
    return " ".join(sentence for sentence in sentences if not LINK.search(sentence))


def preview(meeting: Meeting, place: str) -> MeetingFacts | None:
    """Upcoming meeting with its substantive agenda; None if nothing substantive is listed."""
    items = select(meeting.items)
    if not items:
        return None
    shown = items[:MAX_ITEMS]
    parts = [context(meeting.body, place), f"On the agenda: {'; '.join(i.title for i in shown)}."]
    if len(items) > len(shown):
        parts.append(f"The full agenda lists {len(items) - len(shown)} more items.")
    if meeting.draft_agenda:
        parts.append("The agenda is a draft and may change before the meeting.")
    note = plain_text(_without_links(meeting.note or ""), NOTE_MAX)
    if note:
        parts.append(f"Note from the clerk: {note}")
    return _facts(
        meeting, "meeting_preview", f"{meeting.body} agenda: {_lead(shown[0])}", " ".join(parts)
    )


def outcome(meeting: Meeting, place: str) -> MeetingFacts | None:
    """Recent meeting with recorded results; None if no substantive item has an outcome."""
    items = select([item for item in meeting.items if item.outcome])
    if not items:
        return None
    shown = items[:MAX_ITEMS]
    results = "; ".join(f"{item.title} ({item.outcome})" for item in shown)
    parts = [context(meeting.body, place), f"Recorded outcomes: {results}."]
    if len(items) > len(shown):
        parts.append(f"The meeting record lists {len(items) - len(shown)} more outcomes.")
    parts.append(
        "These results come from the approved minutes."
        if meeting.minutes_final
        else "These results come from the clerk's meeting record; the official minutes are "
        "not yet approved."
    )
    return _facts(
        meeting, "meeting_outcome", f"{meeting.body} decisions: {_lead(shown[0])}", " ".join(parts)
    )
