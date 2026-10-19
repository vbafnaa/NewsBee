"""BiblioCommons events from the public gateway JSON API behind a library's own events pages.

The API is undocumented, so use is deliberately narrow: requests are filtered server-side to
the date window and in-town locations, paced, and capped at MAX_FEED_ITEMS events.
Descriptions are kept as plain text for local authoring; images are not.
"""

import json
import re
import time
from collections import Counter
from collections.abc import Callable
from datetime import datetime

from projects.backend.modules.source_connectors.connectors.common import (
    MAX_FEED_ITEMS,
    EventFacts,
    FeedFormatError,
    check_count,
    plain_text,
    schedule_text,
)

GATEWAY = "https://gateway.bibliocommons.com/v2/libraries/{slug}"
PAGE_LIMIT = 100
MAX_PAGES = MAX_FEED_ITEMS // PAGE_LIMIT
REQUEST_INTERVAL_SECONDS = 1.0
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SLUG_PATTERNS = (
    re.compile(r"bibliocommons\.com(?:\\?/)v2(?:\\?/)libraries(?:\\?/)([a-z0-9-]{1,40})", re.I),
    re.compile(r"(?:\\?/){2}([a-z0-9-]{1,40})\.bibliocommons\.com", re.I),
)
SHARED_HOSTS = re.compile(r"gateway|static|cdn|help|support|^www$|^api$", re.I)

Get = Callable[[str], bytes]


def find_slug(html: str) -> str | None:
    """The library's BiblioCommons slug, if one slug clearly dominates the page."""
    found = Counter(
        slug.lower()
        for pattern in SLUG_PATTERNS
        for slug in pattern.findall(html)
        if not SHARED_HOSTS.search(slug)
    )
    ranked = found.most_common(2)
    if not ranked or (len(ranked) == 2 and ranked[0][1] == ranked[1][1]):
        return None
    return ranked[0][0]


def _json(content: bytes) -> dict:
    try:
        data = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FeedFormatError("BiblioCommons response is not JSON") from error
    if not isinstance(data, dict):
        raise FeedFormatError("BiblioCommons response is not a JSON object")
    return data


def event_count(content: bytes) -> int:
    return int(_json(content).get("events", {}).get("pagination", {}).get("count") or 0)


def locations(content: bytes) -> dict[str, str]:
    """Location id -> 'Name, number street, city' (the text matched against branches)."""
    entities = _json(content).get("entities", {}).get("locations", {})
    found = {}
    for identity, location in entities.items():
        if not SAFE_ID.match(str(identity)) or location.get("isHidden"):
            continue
        address = location.get("address") or {}
        street = " ".join(filter(None, [address.get("number"), address.get("street")]))
        parts = [location.get("name"), street, address.get("city")]
        found[str(identity)] = ", ".join(part.strip() for part in parts if part and part.strip())
    return found


def _moment(value: str | None) -> datetime | None:
    try:
        return datetime.strptime(value or "", "%Y-%m-%dT%H:%M")
    except ValueError:
        return None


def parse(content: bytes, slug: str, venues: dict[str, str]) -> tuple[list[EventFacts], Counter]:
    data = _json(content)
    listing = data.get("events", {})
    order = listing.get("results", [])
    if int(listing.get("pagination", {}).get("count") or 0) and not order:
        raise FeedFormatError("BiblioCommons reported events but listed none (format change?)")
    entities = data.get("entities", {}).get("events", {})
    check_count(len(order))
    events, skipped = [], Counter()
    for identity in order:
        entry = entities.get(identity) or {}
        definition = entry.get("definition") or {}
        if not SAFE_ID.match(str(identity)) or not definition.get("title"):
            raise FeedFormatError("Event is missing an id or title")
        if definition.get("isCancelled"):
            skipped["cancelled"] += 1
            continue
        venue = venues.get(str(definition.get("branchLocationId")))
        if venue is None:
            skipped["no_venue"] += 1
            continue
        start = _moment(definition.get("start"))
        if start is None:
            skipped["unsupported_time"] += 1
            continue
        events.append(
            EventFacts(
                source_event_id=str(identity),
                title=" ".join(str(definition["title"]).split()),
                event_date=start.date().isoformat(),
                schedule_text=schedule_text(start, _moment(definition.get("end"))),
                venue=venue,
                source_url=f"https://{slug}.bibliocommons.com/events/{identity}",
                description=plain_text(definition.get("description")),
            )
        )
    return events, skipped


def fetch(
    get: Get,
    slug: str,
    window: tuple[str, str],
    wanted: Callable[[str], bool],
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[list[EventFacts], Counter, bytes, str]:
    """Return (events, skipped, raw responses, detail) for in-town locations only."""
    base = GATEWAY.format(slug=slug)
    every = locations(get(f"{base}/locations?limit={PAGE_LIMIT}"))
    venues = {identity: text for identity, text in every.items() if wanted(text)}
    detail = f"bibliocommons feed ({len(venues)} of {len(every)} locations in town)"
    if not venues:
        return [], Counter(), b"", detail
    events, skipped, raw = [], Counter(), []
    for page in range(1, MAX_PAGES + 1):
        sleep(REQUEST_INTERVAL_SECONDS)
        content = get(
            f"{base}/events/search?startDate={window[0]}&endDate={window[1]}"
            f"&locations={','.join(sorted(venues))}&limit={PAGE_LIMIT}&page={page}"
        )
        raw.append(content)
        pagination = _json(content).get("events", {}).get("pagination", {})
        check_count(int(pagination.get("count") or 0))
        found, dropped = parse(content, slug, venues)
        events += found
        skipped += dropped
        if page >= int(pagination.get("pages") or 1):
            break
    return events, skipped, b"\n".join(raw), detail
