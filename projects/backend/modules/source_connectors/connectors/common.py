"""Shared event facts and safety limits for every library event feed parser."""

import html
import re
from datetime import date, datetime
from html.parser import HTMLParser
from urllib.parse import urlsplit

from pydantic import BaseModel

MAX_FEED_BYTES = 4 * 1024 * 1024
MAX_FEED_ITEMS = 500
DESCRIPTION_MAX = 1500


class EventFacts(BaseModel):
    """Fields retained from a source. Descriptions are plain text, local evaluation only."""

    source_event_id: str
    title: str
    event_date: str
    schedule_text: str
    venue: str
    venue_url: str | None = None
    room: str | None = None
    source_url: str
    description: str | None = None


class _Text(HTMLParser):
    BREAKS = frozenset({"br", "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "tr"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs) -> None:
        if tag in self.BREAKS:
            self.parts.append("\n")

    def handle_endtag(self, tag) -> None:
        if tag in self.BREAKS:
            self.parts.append("\n")

    def handle_data(self, data) -> None:
        self.parts.append(data)


def plain_text(value: str | None, limit: int = DESCRIPTION_MAX) -> str | None:
    """HTML or text -> single-spaced sentences, cut at a word boundary within `limit`."""
    if not value or not isinstance(value, str):
        return None
    parser = _Text()
    parser.feed(html.unescape(value) if "<" not in value else value)
    parser.close()
    lines = (" ".join(line.split()) for line in "".join(parser.parts).splitlines())
    text = " ".join(
        line if line[-1] in ".!?:;" else f"{line}." for line in lines if line.strip(" .")
    )
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "..."
    return text or None


class FeedFormatError(ValueError):
    pass


def check_size(content: bytes) -> None:
    if len(content) > MAX_FEED_BYTES:
        raise FeedFormatError("Feed exceeds the 4 MiB ingestion limit")


def check_count(count: int) -> None:
    if count > MAX_FEED_ITEMS:
        raise FeedFormatError(f"Feed exceeds the {MAX_FEED_ITEMS}-item ingestion limit")


def reject_unsafe_xml(content: bytes) -> None:
    # Rejecting NULs also prevents UTF-16 bypasses of the declaration check.
    if b"\x00" in content or re.search(rb"<!\s*(DOCTYPE|ENTITY)\b", content, re.I):
        raise FeedFormatError("DTD/entity declarations and NUL bytes are not supported")


def https_link(value: str | None) -> str | None:
    url = urlsplit((value or "").strip())
    if url.scheme == "https" and url.hostname and not url.username and not url.password:
        return url.geturl()
    return None


def _clock(moment: datetime) -> str:
    hour = moment.hour % 12 or 12
    minutes = f":{moment.minute:02d}" if moment.minute else ""
    return f"{hour}{minutes}{'am' if moment.hour < 12 else 'pm'}"


def schedule_text(start: date | datetime, end: date | datetime | None) -> str:
    """Describe the published start and end exactly, in the source's own local time."""
    text = f"{start:%A}, {start:%B} {start.day}, {start.year}"
    if isinstance(start, datetime):
        text += f", {_clock(start)}"
        if isinstance(end, datetime) and end > start:
            text += f" \u2013 {_clock(end)}" if end.date() == start.date() else ""
    return text
