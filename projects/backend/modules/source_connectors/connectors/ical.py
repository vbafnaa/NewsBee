"""iCalendar (RFC 5545) VEVENTs. Only single, non-recurring events with a location and URL."""

import re
from collections import Counter
from datetime import date, datetime

from projects.backend.modules.source_connectors.connectors.common import (
    EventFacts,
    FeedFormatError,
    check_count,
    check_size,
    https_link,
    plain_text,
    schedule_text,
)


def _unescape(value: str) -> str:
    return re.sub(r"\\([\\;,nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value)


def _moment(value: str, params: str) -> date | datetime | None:
    """Local or zoned times are kept as published; UTC times have no stated local time."""
    try:
        if len(value) == 8 or (
            "VALUE=DATE" in params.upper() and "DATE-TIME" not in params.upper()
        ):
            return datetime.strptime(value, "%Y%m%d").date()
        if value.endswith("Z"):
            return None
        return datetime.strptime(value, "%Y%m%dT%H%M%S")
    except ValueError:
        return None


def events_from_lines(lines: list[str]) -> list[dict[str, tuple[str, str]]]:
    events, current = [], None
    for line in lines:
        name_params, _, value = line.partition(":")
        name, _, params = name_params.partition(";")
        name = name.upper()
        if name == "BEGIN" and value.upper() == "VEVENT":
            current = {}
        elif name == "END" and value.upper() == "VEVENT" and current is not None:
            events.append(current)
            current = None
        elif current is not None and name not in current:
            current[name] = (params, value)
    return events


def parse(content: bytes) -> tuple[list[EventFacts], Counter]:
    check_size(content)
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise FeedFormatError("iCalendar must be UTF-8") from error
    if not text.lstrip("\ufeff").startswith("BEGIN:VCALENDAR"):
        raise FeedFormatError("Expected an iCalendar, not an HTML or error response")
    lines = re.sub(r"\r?\n[ \t]", "", text).splitlines()
    vevents = events_from_lines(lines)
    check_count(len(vevents))
    events, skipped = [], Counter()
    for vevent in vevents:

        def field(name: str) -> str:
            return _unescape(vevent.get(name, ("", ""))[1]).strip()

        if "RRULE" in vevent or "RECURRENCE-ID" in vevent:
            skipped["recurring"] += 1
            continue
        if not field("LOCATION"):
            skipped["no_venue"] += 1
            continue
        link = https_link(field("URL"))
        if link is None:
            skipped["no_link"] += 1
            continue
        start = _moment(*reversed(vevent.get("DTSTART", ("", ""))))
        if start is None:
            skipped["unsupported_time"] += 1
            continue
        end = _moment(*reversed(vevent.get("DTEND", ("", "")))) if "DTEND" in vevent else None
        if not field("SUMMARY") or not field("UID"):
            raise FeedFormatError("Event is missing title or UID")
        venue, _, room = field("LOCATION").partition("\n")
        events.append(
            EventFacts(
                source_event_id=field("UID"),
                title=" ".join(field("SUMMARY").split()),
                event_date=(start.date() if isinstance(start, datetime) else start).isoformat(),
                schedule_text=schedule_text(start, end),
                venue=" ".join(venue.split()),
                room=" ".join(room.split()) or None,
                source_url=link,
                description=plain_text(field("DESCRIPTION")),
            )
        )
    return events, skipped
