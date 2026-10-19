"""Legistar Web API (webapi.legistar.com): public meeting agendas and recorded outcomes.

One request lists every meeting in the date range (filtered server-side), then one request
per meeting fetches its agenda items. Items carry a matter type (Ordinance, Resolution...)
that marks substantive business, and, after the meeting, the clerk's recorded action.
"""

import json
from collections.abc import Callable
from datetime import date, datetime
from urllib.parse import quote

from projects.backend.modules.source_connectors.connectors import meetings
from projects.backend.modules.source_connectors.connectors.common import (
    FeedFormatError,
    check_count,
    https_link,
)

API = "https://webapi.legistar.com/v1/{client}"
WEIGHTS = {"ordinance": 3, "public hearing": 3, "resolution": 2, "appointment": 1}
SKIPPED_MATTERS = {"minutes"}
PASSED = {"pass": "Passed", "fail": "Failed"}


def events_url(client: str, first: date, last: date) -> str:
    query = (
        f"EventDate ge datetime'{first.isoformat()}' and EventDate le datetime'{last.isoformat()}'"
    )
    return f"{API.format(client=client)}/events?$filter={quote(query)}&$orderby=EventDate"


def items_url(client: str, event_id: int) -> str:
    return f"{API.format(client=client)}/events/{event_id}/eventitems?Attachments=0"


def confirm_url(client: str) -> str:
    return f"{API.format(client=client)}/bodies?$top=1"


def _json(content: bytes) -> list:
    try:
        data = json.loads(content)
    except ValueError as error:
        raise FeedFormatError("Legistar response is not JSON") from error
    if not isinstance(data, list):
        raise FeedFormatError("Legistar response is not a list")
    check_count(len(data))
    return [entry for entry in data if isinstance(entry, dict)]


def parse_events(content: bytes) -> list[dict]:
    return _json(content)


def start(event: dict) -> date | datetime:
    day = date.fromisoformat(str(event["EventDate"])[:10])
    try:
        clock = datetime.strptime((event.get("EventTime") or "").strip(), "%I:%M %p")
    except ValueError:
        return day
    return datetime.combine(day, clock.time())


def items(content: bytes) -> list[meetings.Item]:
    found = []
    for entry in sorted(_json(content), key=lambda e: e.get("EventItemAgendaSequence") or 0):
        matter = (entry.get("EventItemMatterType") or "").strip().lower()
        raw = entry.get("EventItemTitle") or ""
        if matter in SKIPPED_MATTERS or (not matter and raw.isupper()):
            continue
        title = meetings.item_title(raw)
        if title is None:
            continue
        passed = (entry.get("EventItemPassedFlagName") or "").strip().lower()
        action = meetings.item_title(entry.get("EventItemActionName")) or PASSED.get(passed)
        found.append(
            meetings.Item(
                title,
                consent=bool(entry.get("EventItemConsent")),
                weight=WEIGHTS.get(matter, 1 if matter else 0) + (passed in PASSED),
                outcome=action,
            )
        )
    return found


def meeting(client: str, event: dict, fetch_items: Callable[[str], bytes]) -> meetings.Meeting:
    status = event.get("EventAgendaStatusName") or ""
    return meetings.Meeting(
        source_event_id=str(event["EventId"]),
        body=meetings.body_name(event.get("EventBodyName") or "Public meeting"),
        start=start(event),
        venue=event.get("EventLocation"),
        source_url=https_link(event.get("EventInSiteURL"))
        or f"https://{client}.legistar.com/Calendar.aspx",
        items=items(fetch_items(items_url(client, event["EventId"]))),
        draft_agenda="draft" in status.lower(),
        minutes_final=(event.get("EventMinutesStatusName") or "").lower().startswith("final"),
        note=event.get("EventComment"),
    )


def is_cancelled(event: dict) -> bool:
    return meetings.cancelled(
        event.get("EventAgendaStatusName"), event.get("EventComment"), event.get("EventBodyName")
    )
