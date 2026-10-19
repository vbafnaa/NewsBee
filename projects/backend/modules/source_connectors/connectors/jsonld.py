"""schema.org Event objects embedded as JSON-LD in an events page."""

import json
from collections import Counter
from datetime import date, datetime
from html.parser import HTMLParser

from projects.backend.modules.source_connectors.connectors.common import (
    EventFacts,
    FeedFormatError,
    check_count,
    check_size,
    https_link,
    plain_text,
    schedule_text,
)


class ScriptParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.capturing = False
        self.blocks: list[str] = []

    def handle_starttag(self, tag, attrs) -> None:
        if tag == "script" and (dict(attrs).get("type") or "").lower() == "application/ld+json":
            self.capturing = True
            self.blocks.append("")

    def handle_endtag(self, tag) -> None:
        if tag == "script":
            self.capturing = False

    def handle_data(self, data) -> None:
        if self.capturing:
            self.blocks[-1] += data


def json_ld_blocks(html: str) -> list:
    parser = ScriptParser()
    parser.feed(html)
    values = []
    for block in parser.blocks:
        try:
            values.append(json.loads(block))
        except json.JSONDecodeError:
            continue
    return values


def _is_event(node: dict) -> bool:
    kinds = node.get("@type")
    kinds = kinds if isinstance(kinds, list) else [kinds]
    return any(isinstance(kind, str) and kind.endswith("Event") for kind in kinds)


def find_events(value) -> list[dict]:
    if isinstance(value, list):
        return [event for item in value for event in find_events(item)]
    if not isinstance(value, dict):
        return []
    if _is_event(value):
        return [value]
    return find_events(value.get("@graph", []))


def _moment(value) -> date | datetime | None:
    """Times with a UTC offset are kept as the published local time; 'Z' has no local time."""
    if not isinstance(value, str) or value.endswith("Z"):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if "T" not in value:
        return moment.date()
    return moment.replace(tzinfo=None)


def _venue(location) -> str | None:
    location = location[0] if isinstance(location, list) and location else location
    if isinstance(location, str):
        return location.strip() or None
    if not isinstance(location, dict) or location.get("@type") == "VirtualLocation":
        return None
    address = location.get("address")
    street = address.get("streetAddress") if isinstance(address, dict) else address
    parts = [part.strip() for part in (location.get("name"), street) if isinstance(part, str)]
    return ", ".join(dict.fromkeys(filter(None, parts))) or None


def parse(content: bytes) -> tuple[list[EventFacts], Counter]:
    check_size(content)
    nodes = [
        event
        for block in json_ld_blocks(content.decode("utf-8", "replace"))
        for event in find_events(block)
    ]
    check_count(len(nodes))
    if not nodes:
        raise FeedFormatError("Page has no schema.org Event JSON-LD")
    events, skipped = [], Counter()
    for node in nodes:
        title = node.get("name")
        venue = _venue(node.get("location"))
        link = https_link(node.get("url") if isinstance(node.get("url"), str) else None)
        start = _moment(node.get("startDate"))
        if not venue:
            skipped["no_venue"] += 1
            continue
        if link is None:
            skipped["no_link"] += 1
            continue
        if start is None:
            skipped["unsupported_time"] += 1
            continue
        if not isinstance(title, str) or not title.strip():
            raise FeedFormatError("Event is missing a title")
        events.append(
            EventFacts(
                source_event_id=str(node.get("@id") or link),
                title=" ".join(title.split()),
                event_date=(start.date() if isinstance(start, datetime) else start).isoformat(),
                schedule_text=schedule_text(start, _moment(node.get("endDate"))),
                venue=" ".join(venue.split()),
                source_url=link,
                description=plain_text(node.get("description")),
            )
        )
    return events, skipped
