"""Synthetic onboarded location and library websites shared by ingestion tests (no network)."""

from datetime import date

import httpx

from projects.backend.modules.communities import locations
from projects.backend.shared.configuration.settings import ROOT

LOCATION_ID = "seattle-wa"
TODAY = date(2026, 10, 31)
HOMEPAGE = "https://www.spl.org/"
CALENDAR = "https://www.spl.org/event-calendar"
FEED_URL = "https://www.trumba.com/calendars/kalendaro.rss?weeks=1"
SPUD = b'<script>$Trumba.addSpud({ webName: "kalendaro", spudType: "main" });</script>'


def profile() -> dict:
    return {
        "id": LOCATION_ID,
        "name": "Seattle, WA",
        "directory_edition": "FY2022",
        "systems": [
            {
                "fscskey": "WA0001",
                "name": "Example City Library",
                "latitude": 47.6,
                "longitude": -122.3,
                "website": HOMEPAGE,
                "website_lookup": {"status": "resolved", "website": HOMEPAGE, "detail": "fixture"},
                "branches": [{"name": "Capitol Hill", "address": "425 Harvard Ave E"}],
            },
            {
                "fscskey": "WA0002",
                "name": "Example County Library",
                "latitude": 47.5,
                "longitude": -122.2,
                "website": None,
                "website_lookup": {"status": "unresolved", "website": None, "detail": "fixture"},
                "branches": [{"name": "Lake Example", "address": "1 Example Way"}],
            },
        ],
    }


def onboard(database) -> dict:
    location = profile()
    locations.save(database, location)
    return location


def feed() -> bytes:
    return (ROOT / "tests" / "fixtures" / "library_events.xml").read_bytes()


def routes(feed_content: bytes | None = None, homepage: bytes | None = None) -> dict:
    """URL -> response. The homepage links to the calendar page, which embeds Trumba."""
    return {
        HOMEPAGE: httpx.Response(
            200,
            content=homepage or b'<a href="/event-calendar">Events</a><a href="/about">About</a>',
        ),
        CALENDAR: httpx.Response(200, content=b"<html>" + SPUD + b"</html>"),
        FEED_URL: httpx.Response(200, content=feed() if feed_content is None else feed_content),
    }


def transport(table: dict | None = None, seen: list | None = None) -> httpx.MockTransport:
    table = routes() if table is None else table

    def respond(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if seen is not None:
            seen.append(url)
        if request.url.path == "/robots.txt" and url not in table:
            return httpx.Response(404)
        response = table.get(url)
        if response is None:
            return httpx.Response(404)
        if callable(response):
            return response(request)
        return httpx.Response(
            response.status_code, headers=response.headers, content=response.content
        )

    return httpx.MockTransport(respond)


def ingest(settings, job, table: dict | None = None, today: date = TODAY) -> None:
    from projects.backend.modules.source_connectors.pipelines.events import ingest as run

    with httpx.Client(transport=transport(table)) as client:
        run(settings, job, client, today=today)


COUNTY_HOME = "https://county.example/"
GATEWAY = "https://gateway.bibliocommons.com/v2/libraries/exco"


def biblio_locations() -> dict:
    return {
        "entities": {
            "locations": {
                "1": {
                    "name": "Lake Example",
                    "address": {"number": "1", "street": "Example Way", "city": "Example"},
                },
                "2": {"name": "Faraway", "address": {"street": "9 Far Rd", "city": "Elsewhere"}},
                "3": {"name": "Lake Example Annex", "isHidden": True},
            }
        }
    }


def biblio_event(identity: str, start: str, **definition) -> dict:
    base = {"title": f"Event {identity}", "start": start, "branchLocationId": "1"}
    return {"id": identity, "definition": {**base, **definition}, "description": "PRIVATE"}


def biblio_events(*events: dict, pages: int = 1) -> dict:
    return {
        "events": {
            "results": [event["id"] for event in events],
            "pagination": {"count": len(events), "pages": pages, "page": 1},
        },
        "entities": {"events": {event["id"]: event for event in events}},
    }


def biblio_routes(start: str = "2026-11-01", end: str = "2026-11-07") -> dict:
    """County homepage embeds a BiblioCommons catalog; its gateway has in-town events."""
    events = biblio_events(
        biblio_event("ev1", "2026-11-02T10:30", end="2026-11-02T11:15", title="Lego  Club"),
        biblio_event("ev2", "2026-11-03T18:00", isCancelled=True),
    )
    return {
        COUNTY_HOME: httpx.Response(
            200, content=b'<a href="https://exco.bibliocommons.com/v2/search">Catalog</a>'
        ),
        f"{GATEWAY}/events/search?limit=1": httpx.Response(200, json=events),
        f"{GATEWAY}/locations?limit=100": httpx.Response(200, json=biblio_locations()),
        f"{GATEWAY}/events/search?startDate={start}&endDate={end}&locations=1&limit=100&page=1": (
            httpx.Response(200, json=events)
        ),
    }
