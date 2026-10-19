"""Facts and guardrails shared by the wider-area connectors (hazards, state news, trending).

When a small town has little local news, the edition widens to its county and nearby places
(never the whole state). Those stories carry a ``tier`` (local, region, nearby) so editions
fill with local stories first,
and a reader-facing ``section`` label so wider stories are never mistaken for town news.
"""

import re
import xml.etree.ElementTree as ET
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from typing import Literal

from projects.backend.modules.source_connectors.connectors.common import (
    EventFacts,
    FeedFormatError,
    check_count,
    check_size,
    https_link,
    plain_text,
    reject_unsafe_xml,
    schedule_text,
)

NewsKind = Literal["earthquake", "state_news", "trending_topic", "social_trend"]
Tier = Literal["local", "region", "nearby"]
NEWS_KINDS = frozenset(NewsKind.__args__)
WIDER_TIERS = frozenset({"region", "nearby"})
TITLE_MAX = 200

# Topics a family community newsletter should not resurface from wider-area sources:
# violence, crimes by individuals, deaths and self-harm. Applied to titles and summaries.
SENSITIVE = re.compile(
    r"\b(murder\w*|homicide|kill(?:ed|ing|ings|er)|shooting|stabb\w*|massacre|serial|"
    r"rape\w*|sexual|assault\w*|abus(?:e|ed|ive)|suicide|overdos\w*|fatal\w*|dead|death\w*|"
    r"died|obituar\w*|funeral|sentenc\w*|convict\w*|guilty|indict\w*|arrest\w*|"
    r"charged|kidnap\w*|missing person|manhunt|porn\w*|nude|terror\w*|hostage)\b",
    re.IGNORECASE,
)


class NewsFacts(EventFacts):
    """A wider-area story: ``venue`` is the publisher or place, ``event_date`` the day the
    item was published or measured, and ``signals`` the numbers it was ranked on."""

    kind: NewsKind
    tier: Tier
    section: str
    signals: dict[str, float | int | str] = {}
    social_mentions: int | None = None


def sensitive(*texts: str | None) -> bool:
    return any(text and SENSITIVE.search(text) for text in texts)


def mentions(text: str | None, name: str | None) -> bool:
    """Whole-word, case-insensitive mention of a place or topic name."""
    if not text or not name:
        return False
    return re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", text, re.IGNORECASE) is not None


def published_text(day: date) -> str:
    return schedule_text(day, None)


def _published(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        moment = parsedate_to_datetime(value.strip())
    except (TypeError, ValueError, IndexError):
        try:
            moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _child(node: ET.Element, *names: str) -> str | None:
    for name in names:
        found = node.find(name)
        if found is not None:
            text = found.text or found.get("href")
            if text and text.strip():
                return text.strip()
    return None


ATOM = "{http://www.w3.org/2005/Atom}"


def parse_feed(content: bytes) -> list[dict]:
    """RSS 2.0 or Atom -> [{id, title, link, published, summary}], newest first.

    Items without a title, an HTTPS link or a parseable date are dropped."""
    check_size(content)
    reject_unsafe_xml(content)
    try:
        root = ET.fromstring(content)
    except ET.ParseError as error:
        raise FeedFormatError(f"Feed is not well-formed XML: {error}") from error
    nodes = root.findall("./channel/item") or root.findall(f"{ATOM}entry")
    check_count(len(nodes))
    items, seen = [], set()
    for node in nodes:
        title = plain_text(_child(node, "title", f"{ATOM}title"), TITLE_MAX)
        link = https_link(_child(node, "link", f"{ATOM}link"))
        published = _published(
            _child(node, "pubDate", f"{ATOM}published", f"{ATOM}updated", "date")
        )
        if not title or not link or published is None or link in seen:
            continue
        seen.add(link)
        summary = _child(node, "description", f"{ATOM}summary", f"{ATOM}content")
        items.append(
            {
                "id": _child(node, "guid", f"{ATOM}id") or link,
                "title": title.rstrip("."),
                "link": link,
                "published": published,
                "summary": plain_text(summary),
            }
        )
    return sorted(items, key=lambda item: item["published"], reverse=True)
