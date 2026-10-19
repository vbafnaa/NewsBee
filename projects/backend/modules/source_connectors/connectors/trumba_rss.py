"""Trumba calendar RSS: schedule line first, then labelled 'Location Link' and 'Room Location'."""

import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime
from html.parser import HTMLParser

from projects.backend.modules.source_connectors.connectors.common import (
    EventFacts,
    FeedFormatError,
    check_count,
    check_size,
    https_link,
    plain_text,
    reject_unsafe_xml,
)


class FactParser(HTMLParser):
    """Schedule line first, labelled venue fields, and every other line as description."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.line = ""
        self.schedule: str | None = None
        self.venue: str | None = None
        self.venue_url: str | None = None
        self.room: str | None = None
        self.details: list[str] = []

    def handle_starttag(self, tag, attrs) -> None:
        if tag == "br":
            self.finish_line()
        elif tag == "a" and self.line.strip().startswith("Location Link:"):
            self.venue_url = dict(attrs).get("href")

    def handle_data(self, data) -> None:
        self.line += data

    def finish_line(self) -> None:
        line = " ".join(self.line.split())
        if self.schedule is None:
            self.schedule = line
        elif line.startswith("Location Link:"):
            self.venue = line.removeprefix("Location Link:").strip() or None
        elif line.startswith("Room Location:"):
            self.room = line.removeprefix("Room Location:").strip() or None
        elif line:
            self.details.append(line)
        self.line = ""


def parse(content: bytes) -> tuple[list[EventFacts], Counter]:
    """Return events with a labelled venue and counts of items skipped by reason."""
    check_size(content)
    reject_unsafe_xml(content)
    try:
        root = ET.fromstring(content)
    except ET.ParseError as error:
        raise FeedFormatError(f"Invalid RSS XML: {error}") from error
    channel = root.find("channel")
    if root.tag != "rss" or channel is None:
        raise FeedFormatError("Expected an RSS channel, not an HTML or error response")
    items = channel.findall("item")
    check_count(len(items))
    events = []
    skipped: Counter = Counter()
    for item in items:
        facts = FactParser()
        facts.feed(item.findtext("description", ""))
        facts.finish_line()
        if not facts.venue:
            skipped["no_venue"] += 1
            continue
        title = item.findtext("title", "").strip()
        identity = item.findtext("guid", "").strip()
        link = https_link(item.findtext("link"))
        try:
            event_date = datetime.strptime(
                item.findtext("category", "").split(" ")[0], "%Y/%m/%d"
            ).date()
        except ValueError as error:
            raise FeedFormatError("Event is missing a supported calendar date") from error
        if not title or not identity or not facts.schedule:
            raise FeedFormatError("Event is missing title, ID, or schedule")
        if link is None:
            raise FeedFormatError("Event link must be an HTTPS URL")
        events.append(
            EventFacts(
                source_event_id=identity,
                title=title,
                event_date=event_date.isoformat(),
                schedule_text=facts.schedule,
                venue=facts.venue,
                venue_url=https_link(facts.venue_url),
                room=facts.room,
                source_url=link,
                description=plain_text("\n".join(facts.details)),
            )
        )
    if items and not events:
        raise FeedFormatError("No event has explicit venue attribution; feed format changed?")
    return events, skipped
