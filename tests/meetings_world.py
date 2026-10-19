"""Synthetic town websites and Legistar/CivicClerk APIs for government meeting tests."""

from datetime import date

import httpx

from projects.backend.modules.source_connectors.connectors import civicclerk, legistar
from tests.library_world import TODAY

TOWN = "Exampletown, WA"
WEBSITE = "https://www.exampletown.gov/"
LEGISTAR = "exampletown"
CIVICCLERK = "exampleville"
PAST_START, WINDOW = date(2026, 10, 24), ("2026-11-01", "2026-11-07")


def key(url: str) -> str:
    return str(httpx.URL(url))


def government(platform: str = "legistar", tenant: str = LEGISTAR) -> dict:
    return {
        "status": "detected",
        "platform": platform,
        "tenant": tenant,
        "website": WEBSITE,
        "wikidata_id": "Q1",
        "pages_checked": [WEBSITE],
        "detail": "fixture",
    }


def legistar_event(identity: int, day: str, body: str = "City Council", **extra) -> dict:
    return {
        "EventId": identity,
        "EventBodyName": body,
        "EventDate": f"{day}T00:00:00",
        "EventTime": "7:00 PM",
        "EventLocation": "City Hall, 1 Main St",
        "EventAgendaStatusName": "Final",
        "EventMinutesStatusName": "Draft",
        "EventInSiteURL": f"https://{LEGISTAR}.legistar.com/MeetingDetail.aspx?ID={identity}",
        "EventComment": None,
        **extra,
    }


def legistar_item(title: str, matter: str | None = None, **extra) -> dict:
    return {
        "EventItemTitle": title,
        "EventItemMatterType": matter,
        "EventItemConsent": 0,
        "EventItemActionName": None,
        "EventItemPassedFlagName": None,
        **extra,
    }


UPCOMING_ITEMS = [
    legistar_item("CALL TO ORDER"),
    legistar_item("Approval of the minutes of October 20", "Minutes"),
    legistar_item("Reasonable accommodation: call the clerk for sign language interpreters"),
    legistar_item("Resolution approving the playground contract", "Resolution", EventItemConsent=1),
    legistar_item("An ordinance banning glue traps", "Ordinance"),
    legistar_item("Public comment"),
]
PAST_ITEMS = [
    legistar_item("ROLL CALL"),
    legistar_item(
        "Ordinance on short-term rentals",
        "Ordinance",
        EventItemActionName="Adopted on Second Reading",
        EventItemPassedFlagName="Pass",
    ),
    legistar_item("Resolution to rename Elm Park", "Resolution", EventItemPassedFlagName="Fail"),
    legistar_item("Report on snow plowing", "Report or Communication "),
]


def legistar_routes() -> dict:
    events = [
        legistar_event(
            1,
            "2026-11-03",
            EventComment="Watch live at www.exampletown.gov/tv. Comments are taken in person.",
        ),
        legistar_event(2, "2026-11-04", "Planning Commission", EventComment="Meeting Cancelled"),
        legistar_event(3, "2026-10-28"),
        legistar_event(4, TODAY.isoformat()),
        legistar_event(5, "2026-10-27", "Parks Advisory Board"),
    ]
    return {
        key(legistar.events_url(LEGISTAR, PAST_START, date(2026, 11, 7))): httpx.Response(
            200, json=events
        ),
        key(legistar.items_url(LEGISTAR, 1)): httpx.Response(200, json=UPCOMING_ITEMS),
        key(legistar.items_url(LEGISTAR, 3)): httpx.Response(200, json=PAST_ITEMS),
        key(legistar.items_url(LEGISTAR, 5)): httpx.Response(
            200, json=[legistar_item("Discussion of trail signs", "Discussion")]
        ),
    }


def civicclerk_event(identity: int, start: str, name: str, agenda: int = 0, **extra) -> dict:
    return {
        "id": identity,
        "eventName": name,
        "startDateTime": start,
        "agendaId": agenda,
        "hasAgenda": bool(agenda),
        "isPublished": "Published",
        "eventLocation": {"address1": "1 School St", "city": "Exampleville"},
        **extra,
    }


def leaf(name: str) -> dict:
    return {"agendaObjectItemName": name, "isSection": 0, "childItems": []}


AGENDA = {
    "items": [
        {
            "agendaObjectItemName": "CONSENT AGENDA",
            "isSection": 1,
            "childItems": [leaf("September 10th Minutes"), leaf("Adopt the 2027 school calendar")],
        },
        {"agendaObjectItemName": "PUBLIC FORUM", "isSection": 1, "childItems": []},
        leaf("PUBLIC FORUM - Verbal Comments"),
        leaf("Jane Doe (tenant); Acme LLC (landlord) Security Deposit Case Re: 4 Elm Street"),
        leaf("\u2022Treasurer's Report"),
        leaf("Update on the new middle school (15 minutes)"),
    ]
}


def civicclerk_routes() -> dict:
    events = {
        "value": [
            civicclerk_event(10, "2026-11-02T18:00:00Z", "Board of Education Regular Meeting", 11),
            civicclerk_event(12, "2026-11-03T18:00:00Z", "*Meeting Cancelled* Housing Board", 13),
            civicclerk_event(14, "2026-11-05T09:00:00Z", "Library Commission"),
        ]
    }
    url = civicclerk.events_url(CIVICCLERK, date(2026, 11, 1), date(2026, 11, 8))
    return {
        key(url): httpx.Response(200, json=events),
        key(civicclerk.agenda_url(CIVICCLERK, 11)): httpx.Response(200, json=AGENDA),
    }


def wikidata(label: str = "Exampletown", website: str | None = WEBSITE):
    """Wikidata answering a city search; label mismatch leaves the website unresolved."""

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.params["action"] == "wbsearchentities":
            return httpx.Response(200, json={"search": [{"id": "Q1", "label": label}]})
        claims = {
            "P17": [{"mainsnak": {"datavalue": {"value": {"id": "Q30"}}}}],
            "P625": [
                {"mainsnak": {"datavalue": {"value": {"latitude": 47.6, "longitude": -122.3}}}}
            ],
        }
        if website:
            claims["P856"] = [{"mainsnak": {"datavalue": {"value": website}}}]
        return httpx.Response(200, json={"entities": {"Q1": {"claims": claims}}})

    return respond


def transport(table: dict, seen: list | None = None, wiki=None) -> httpx.MockTransport:
    wiki = wiki or wikidata()

    def respond(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if seen is not None:
            seen.append(url)
        if request.url.host == "www.wikidata.org":
            return wiki(request)
        response = table.get(url)
        if response is None:
            return httpx.Response(404)
        return httpx.Response(
            response.status_code, headers=response.headers, content=response.content
        )

    return httpx.MockTransport(respond)


def town_profile() -> dict:
    return {
        "id": "exampletown-wa",
        "name": TOWN,
        "systems": [{"name": "Exampletown Library", "latitude": 47.6, "longitude": -122.3}],
    }
