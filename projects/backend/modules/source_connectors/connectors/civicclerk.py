"""CivicClerk public API ({tenant}.api.civicclerk.com): upcoming meeting agendas.

Event times are published as local wall-clock times despite a trailing "Z", so they are
read as local. Agenda items come as a tree of sections; only leaf items are kept. The API
records no structured votes, so CivicClerk supplies previews but never outcomes.
"""

import json
from collections.abc import Callable, Iterator
from datetime import date, datetime
from urllib.parse import quote

from projects.backend.modules.source_connectors.connectors import meetings
from projects.backend.modules.source_connectors.connectors.common import (
    FeedFormatError,
    check_count,
)

API = "https://{tenant}.api.civicclerk.com/v1"
PORTAL = "https://{tenant}.portal.civicclerk.com/event/{event_id}/overview"
MAX_DEPTH = 4


def events_url(tenant: str, first: date, last_exclusive: date) -> str:
    query = (
        f"startDateTime ge {first.isoformat()}T00:00:00Z and "
        f"startDateTime lt {last_exclusive.isoformat()}T00:00:00Z"
    )
    return (
        f"{API.format(tenant=tenant)}/Events?$filter={quote(query)}&$orderby=startDateTime&$top=100"
    )


def agenda_url(tenant: str, agenda_id: int) -> str:
    return f"{API.format(tenant=tenant)}/Meetings/{agenda_id}"


def confirm_url(tenant: str) -> str:
    return f"{API.format(tenant=tenant)}/Events?$top=1"


def _object(content: bytes) -> dict:
    try:
        data = json.loads(content)
    except ValueError as error:
        raise FeedFormatError("CivicClerk response is not JSON") from error
    if not isinstance(data, dict):
        raise FeedFormatError("CivicClerk response is not an object")
    return data


def parse_events(content: bytes) -> list[dict]:
    events = _object(content).get("value")
    if not isinstance(events, list):
        raise FeedFormatError("CivicClerk events response has no value list")
    check_count(len(events))
    return [event for event in events if isinstance(event, dict)]


def start(event: dict) -> datetime:
    return datetime.fromisoformat(str(event["startDateTime"]).removesuffix("Z")[:19])


def _leaves(entries: list, depth: int = 0) -> Iterator[dict]:
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        children = entry.get("childItems") or []
        if children and depth < MAX_DEPTH:
            yield from _leaves(children, depth + 1)
        elif not entry.get("isSection"):
            yield entry


def items(content: bytes) -> list[meetings.Item]:
    leaves = list(_leaves(_object(content).get("items") or []))
    check_count(len(leaves))
    titles = (meetings.item_title(entry.get("agendaObjectItemName")) for entry in leaves)
    return [meetings.Item(title) for title in titles if title]


def venue(event: dict) -> str | None:
    place = event.get("eventLocation") or {}
    parts = [place.get("address1"), place.get("city")]
    found = [part.strip() for part in parts if isinstance(part, str) and part.strip()]
    return ", ".join(found) or None


def usable(event: dict) -> bool:
    return bool(
        event.get("agendaId")
        and event.get("hasAgenda")
        and event.get("isPublished") == "Published"
        and not meetings.cancelled(event.get("eventName"))
    )


def meeting(tenant: str, event: dict, fetch: Callable[[str], bytes]) -> meetings.Meeting:
    return meetings.Meeting(
        source_event_id=str(event["id"]),
        body=meetings.body_name(event.get("eventName") or "Public meeting"),
        start=start(event),
        venue=venue(event),
        source_url=PORTAL.format(tenant=tenant, event_id=int(event["id"])),
        items=items(fetch(agenda_url(tenant, int(event["agendaId"])))),
    )
