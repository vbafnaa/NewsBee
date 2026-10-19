import re
import xml.etree.ElementTree as ET
from datetime import datetime
from html.parser import HTMLParser
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict

MAX_FEED_BYTES = 2 * 1024 * 1024


class SourceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Literal["spl-capitol-hill"]
    community_id: Literal["capitol-hill-seattle"]
    connector: Literal["spl_rss"]
    feed_url: Literal["https://www.trumba.com/calendars/kalendaro.rss?filterview=LocationCAP"]
    venue_url: Literal["https://www.spl.org/hours-and-locations/capitol-hill-branch"]
    usage: Literal["local_evaluation_only"]
    redistribution_permission: Literal["unresolved"]


class EventFacts(BaseModel):
    source_event_id: str
    title: str
    event_date: str
    schedule_text: str
    venue: str
    venue_url: str
    room: str | None
    source_url: str


class FeedFormatError(ValueError):
    pass


class FactParser(HTMLParser):
    """Retain only the first schedule line and explicitly labeled venue fields."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.line = ""
        self.schedule: str | None = None
        self.venue: str | None = None
        self.venue_url: str | None = None
        self.room: str | None = None

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
            self.venue = line.removeprefix("Location Link:").strip()
        elif line.startswith("Room Location:"):
            self.room = line.removeprefix("Room Location:").strip() or None
        self.line = ""


def parse_feed(content: bytes, source: SourceConfig) -> tuple[list[EventFacts], int, int]:
    if len(content) > MAX_FEED_BYTES:
        raise FeedFormatError("RSS exceeds the 2 MiB ingestion limit")
    # This feed is UTF-8; rejecting NULs also prevents UTF-16 bypasses of declaration checks.
    if b"\x00" in content or re.search(rb"<!\s*(DOCTYPE|ENTITY)\b", content, re.I):
        raise FeedFormatError("DTD/entity declarations and NUL bytes are not supported")
    try:
        root = ET.fromstring(content)
    except ET.ParseError as error:
        raise FeedFormatError(f"Invalid RSS XML: {error}") from error
    channel = root.find("channel")
    if root.tag != "rss" or channel is None:
        raise FeedFormatError("Expected an RSS channel, not an HTML or error response")
    items = channel.findall("item")
    if len(items) > 200:
        raise FeedFormatError("RSS exceeds the 200-item ingestion limit")
    events = []
    skipped = 0
    closures = 0
    for item in items:
        facts = FactParser()
        facts.feed(item.findtext("description", ""))
        facts.finish_line()
        title = item.findtext("title", "").strip()
        if (
            title.startswith("Library Closed in observance of ")
            and facts.venue is None
            and facts.venue_url is None
        ):
            closures += 1
            continue
        if not facts.venue_url or not facts.venue:
            raise FeedFormatError("Event is missing explicit venue attribution")
        if facts.venue_url.rstrip("/") != source.venue_url:
            skipped += 1
            continue
        identity = item.findtext("guid", "").strip()
        link = item.findtext("link", "").strip()
        date = item.findtext("category", "")
        try:
            event_date = datetime.strptime(date.split(" ")[0], "%Y/%m/%d").date().isoformat()
        except ValueError as error:
            raise FeedFormatError("Event is missing a supported calendar date") from error
        url = urlsplit(link)
        if not title or not identity or not facts.schedule:
            raise FeedFormatError("Event is missing title, ID, or schedule")
        if url.scheme != "https" or url.hostname != "www.spl.org" or url.username or url.password:
            raise FeedFormatError("Event link must point to the official HTTPS library site")
        events.append(
            EventFacts(
                source_event_id=identity,
                title=title,
                event_date=event_date,
                schedule_text=facts.schedule,
                venue=facts.venue,
                venue_url=source.venue_url,
                room=facts.room,
                source_url=link,
            )
        )
    return events, skipped, closures
