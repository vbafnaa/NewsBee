import json

import httpx
import pytest

from projects.backend.modules.source_connectors.agents import library_events
from projects.backend.modules.source_connectors.connectors import (
    bibliocommons,
    ical,
    jsonld,
    trumba_rss,
)
from projects.backend.modules.source_connectors.connectors.common import FeedFormatError
from tests import library_world


def test_trumba_extracts_only_approved_fields():
    events, skipped = trumba_rss.parse(library_world.feed())
    assert skipped == {}
    first = events[0]
    assert (first.event_date, first.venue, first.room) == (
        "2026-11-03",
        "Capitol Hill Branch",
        "Meeting Room",
    )
    assert first.schedule_text == "Tuesday, November 3, 2026, 3 – 4pm"
    assert events[1].venue == "Central Library"
    assert first.description == "Detailed Description: Stories & songs for toddlers."
    assert "do-not-save" not in first.model_dump_json()


@pytest.mark.parametrize(
    "content",
    [
        b"<html>blocked</html>",
        b"<rss><channel>",
        b'<!DOCTYPE rss [<!ENTITY x "unsafe">]><rss><channel/></rss>',
        b"\x00<rss/>",
        b"x" * (4 * 1024 * 1024 + 1),
    ],
    ids=["html", "invalid-xml", "dtd", "nul", "oversized"],
)
def test_trumba_malformed_and_unsafe_responses_fail(content):
    with pytest.raises(FeedFormatError):
        trumba_rss.parse(content)


def test_trumba_missing_dates_and_venues_fail_instead_of_guessing():
    feed = library_world.feed()
    with pytest.raises(FeedFormatError, match="calendar date"):
        trumba_rss.parse(feed.replace(b"2026/11/03", b"unknown"))
    with pytest.raises(FeedFormatError, match="venue attribution"):
        trumba_rss.parse(feed.replace(b"Location Link", b"Unknown Field"))


def test_trumba_items_without_venue_are_counted_not_kept():
    closure = b"<item><title>Library Closed</title><guid>c</guid>"
    closure += b"<category>2026/11/03 (Tue)</category><description>All day</description></item>"
    events, skipped = trumba_rss.parse(
        library_world.feed().replace(b"</channel>", closure + b"</channel>")
    )
    assert len(events) == 2 and skipped == {"no_venue": 1}


ICS = """BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:ics-1\r
SUMMARY:Story time for\r
  everyone\r
DTSTART;TZID=America/Chicago:20261103T100000\r
DTEND;TZID=America/Chicago:20261103T110000\r
LOCATION:Main Library\\nRoom B\r
URL:https://library.example/events/1\r
DESCRIPTION:PRIVATE_DESCRIPTION_MARKER\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:ics-2\r
SUMMARY:Weekly club\r
DTSTART:20261104T100000\r
RRULE:FREQ=WEEKLY\r
LOCATION:Main Library\r
URL:https://library.example/events/2\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:ics-3\r
SUMMARY:UTC event\r
DTSTART:20261104T100000Z\r
LOCATION:Main Library\r
URL:https://library.example/events/3\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:ics-4\r
SUMMARY:Insecure link\r
DTSTART;VALUE=DATE:20261105\r
LOCATION:Main Library\r
URL:http://library.example/events/4\r
END:VEVENT\r
END:VCALENDAR\r
"""


def test_ical_keeps_single_local_events_and_counts_the_rest():
    events, skipped = ical.parse(ICS.encode())
    [event] = events
    assert (event.title, event.venue, event.room, event.event_date) == (
        "Story time for everyone",
        "Main Library",
        "Room B",
        "2026-11-03",
    )
    assert event.schedule_text == "Tuesday, November 3, 2026, 10am – 11am"
    assert event.description == "PRIVATE_DESCRIPTION_MARKER."
    assert skipped == {"recurring": 1, "unsupported_time": 1, "no_link": 1}
    with pytest.raises(FeedFormatError, match="not an HTML"):
        ical.parse(b"<html></html>")


def page_with(*nodes) -> bytes:
    blocks = "".join(
        f'<script type="application/ld+json">{json.dumps(node)}</script>' for node in nodes
    )
    return f"<html><head>{blocks}</head></html>".encode()


def test_jsonld_events_including_graph_are_parsed():
    content = page_with(
        {
            "@graph": [
                {
                    "@type": "EducationEvent",
                    "@id": "ld-1",
                    "name": "Coding club",
                    "startDate": "2026-11-03T15:00:00-05:00",
                    "endDate": "2026-11-03T16:00:00-05:00",
                    "url": "https://library.example/e/1",
                    "location": {
                        "@type": "Place",
                        "name": "Eastside Branch",
                        "address": {"streetAddress": "1 Main St"},
                    },
                    "description": "PRIVATE_DESCRIPTION_MARKER",
                }
            ]
        },
        {
            "@type": "Event",
            "name": "Webinar",
            "startDate": "2026-11-03",
            "url": "https://library.example/e/2",
            "location": {"@type": "VirtualLocation"},
        },
    )
    events, skipped = jsonld.parse(content)
    [event] = events
    assert (event.venue, event.event_date, event.source_event_id) == (
        "Eastside Branch, 1 Main St",
        "2026-11-03",
        "ld-1",
    )
    assert event.schedule_text == "Tuesday, November 3, 2026, 3pm – 4pm"
    assert skipped == {"no_venue": 1}
    with pytest.raises(FeedFormatError, match="no schema.org Event"):
        jsonld.parse(page_with({"@type": "Organization"}))


@pytest.mark.parametrize(
    ("html", "kind", "url"),
    [
        (library_world.SPUD.decode(), "trumba_rss", library_world.FEED_URL),
        (
            '<link rel="alternate" type="text/calendar" href="/events.ics">',
            "ical",
            "https://library.example/events.ics",
        ),
        (
            '<a href="webcal://library.example/cal.ics">Subscribe</a>',
            "ical",
            "https://library.example/cal.ics",
        ),
        ('<a href="http://library.example/cal.ics">Insecure</a>', None, None),
        (
            page_with({"@type": "Event", "name": "x"}).decode(),
            "jsonld",
            "https://library.example/events",
        ),
        ("<p>Nothing</p>", None, None),
    ],
    ids=["trumba", "ical-link", "webcal", "http-ics", "jsonld", "none"],
)
def test_find_feed_supports_only_known_formats(html, kind, url):
    feed = library_events.find_feed(html, "https://library.example/events")
    assert (feed.kind, feed.url) == (kind, url) if kind else feed is None


def test_candidate_pages_are_same_site_bounded_and_ranked():
    html = """
      <a href="/about">About</a><a href="https://other.example/events">Elsewhere</a>
      <a href="/whats-on">Calendar</a><a href="https://events.library.example/list">x</a>
      <a href="/events#top">Events</a><a href="/event-calendar">All</a>
      <a href="http://library.example/events/old">Old</a>
    """
    assert library_events.candidate_pages(html, "https://library.example/") == [
        "https://library.example/events",
        "https://library.example/event-calendar",
        "https://library.example/whats-on",
    ]


def fetcher(table) -> library_events.Fetcher:
    return library_events.Fetcher(httpx.Client(transport=library_world.transport(table)))


def test_fetcher_follows_bounded_https_redirects():
    table = {
        f"https://library.example/{index}": httpx.Response(
            302, headers={"location": f"/{index + 1}"}
        )
        for index in range(5)
    }
    table["https://library.example/5"] = httpx.Response(200, content=b"ok")
    final, content = fetcher(table).get("https://library.example/2", 100, "text/html")
    assert (final, content) == ("https://library.example/5", b"ok")
    with pytest.raises(FeedFormatError, match="redirects"):
        fetcher(table).get("https://library.example/0", 100, "text/html")
    with pytest.raises(FeedFormatError, match="exceeds"):
        fetcher(table).get("https://library.example/5", 1, "text/html")
    with pytest.raises(FeedFormatError, match="non-HTTPS"):
        fetcher(table).get("http://library.example/5", 100, "text/html")


@pytest.mark.parametrize(
    ("robots", "allowed"),
    [
        (httpx.Response(200, text="User-agent: *\nDisallow: /private"), True),
        (httpx.Response(200, text="User-agent: *\nDisallow: /"), False),
        (httpx.Response(403), False),
        (httpx.Response(503), False),
        (httpx.Response(410), True),
    ],
)
def test_robots_rules_are_respected(robots, allowed):
    table = {"https://library.example/robots.txt": robots}
    assert fetcher(table).allowed("https://library.example/events") is allowed


def test_missing_website_is_unresolved_without_requests():
    outcome = library_events.run(httpx.Client(transport=library_world.transport({})), None)
    assert outcome.status == "unresolved_website"


def test_bibliocommons_slug_needs_one_dominant_library():
    find = bibliocommons.find_slug
    assert find('<a href="https://kcls.bibliocommons.com/v2/events">x</a>') == "kcls"
    assert find('{"u":"https:\\/\\/krl.bibliocommons.com\\/x"}') == "krl"
    assert find('"gateway.bibliocommons.com\\/v2\\/libraries\\/krl"') == "krl"
    assert find("//cor-liv-cdn-static.bibliocommons.com //gateway.bibliocommons.com") is None
    assert find("//one.bibliocommons.com //two.bibliocommons.com") is None
    assert find("<p>No catalog</p>") is None


def test_bibliocommons_parse_keeps_only_approved_fields():
    content = json.dumps(
        library_world.biblio_events(
            library_world.biblio_event("ok", "2026-11-02T10:30", end="2026-11-02T11:15"),
            library_world.biblio_event("gone", "2026-11-02T12:00", isCancelled=True),
            library_world.biblio_event("far", "2026-11-02T12:00", branchLocationId="2"),
            library_world.biblio_event("nobranch", "2026-11-02T12:00", branchLocationId=None),
            library_world.biblio_event("allday", "2026-11-02"),
        )
    ).encode()
    events, skipped = bibliocommons.parse(content, "exco", {"1": "Lake Example, 1 Example Way"})
    [event] = events
    assert (event.source_event_id, event.event_date, event.venue, event.source_url) == (
        "ok",
        "2026-11-02",
        "Lake Example, 1 Example Way",
        "https://exco.bibliocommons.com/events/ok",
    )
    assert event.schedule_text == "Monday, November 2, 2026, 10:30am – 11:15am"
    assert "PRIVATE" not in event.model_dump_json()
    assert skipped == {"cancelled": 1, "no_venue": 2, "unsupported_time": 1}


@pytest.mark.parametrize(
    "content",
    [
        b"<html>blocked</html>",
        b"[]",
        json.dumps(library_world.biblio_events({"id": "../x", "definition": {}})).encode(),
        json.dumps(library_world.biblio_events({"id": "e1", "definition": {}})).encode(),
        b'{"events": {"items": ["e1"], "pagination": {"count": 1}}}',
    ],
    ids=["html", "not-object", "unsafe-id", "no-title", "listing-renamed"],
)
def test_bibliocommons_malformed_responses_fail(content):
    with pytest.raises(FeedFormatError):
        bibliocommons.parse(content, "exco", {"1": "x"})


def test_bibliocommons_fetch_filters_server_side_paced_and_paged():
    requested, pauses = [], []
    page = library_world.biblio_events(
        library_world.biblio_event("e1", "2026-11-02T10:00"), pages=2
    )

    def get(url: str) -> bytes:
        requested.append(url)
        body = library_world.biblio_locations() if "/locations" in url else page
        return json.dumps(body).encode()

    events, skipped, raw, detail = bibliocommons.fetch(
        get, "exco", ("2026-11-01", "2026-11-07"), lambda v: "Example" in v, pauses.append
    )
    base = library_world.GATEWAY
    assert requested == [
        f"{base}/locations?limit=100",
        f"{base}/events/search?startDate=2026-11-01&endDate=2026-11-07&locations=1&limit=100&page=1",
        f"{base}/events/search?startDate=2026-11-01&endDate=2026-11-07&locations=1&limit=100&page=2",
    ]
    assert pauses == [bibliocommons.REQUEST_INTERVAL_SECONDS] * 2
    assert len(events) == 2 and raw.count(b"\n") == 1
    assert detail == "bibliocommons feed (1 of 2 locations in town)"


def test_bibliocommons_fetch_skips_events_when_no_location_is_in_town():
    requested = []

    def get(url: str) -> bytes:
        requested.append(url)
        return json.dumps(library_world.biblio_locations()).encode()

    events, _, raw, detail = bibliocommons.fetch(
        get, "exco", ("2026-11-01", "2026-11-07"), lambda v: False, lambda _: None
    )
    assert (events, raw, len(requested)) == ([], b"", 1)
    assert detail.endswith("(0 of 2 locations in town)")


def test_bibliocommons_fetch_rejects_oversized_results():
    big = library_world.biblio_events()
    big["events"]["pagination"]["count"] = 501

    def get(url: str) -> bytes:
        body = library_world.biblio_locations() if "/locations" in url else big
        return json.dumps(body).encode()

    with pytest.raises(FeedFormatError, match="500-item"):
        bibliocommons.fetch(get, "exco", ("a", "b"), lambda v: True, lambda _: None)


def test_agent_discovers_bibliocommons_and_ingests_in_town_events():
    client = httpx.Client(transport=library_world.transport(library_world.biblio_routes()))
    outcome = library_events.run(
        client,
        library_world.COUNTY_HOME,
        ("2026-11-01", "2026-11-07"),
        lambda venue: venue.startswith("Lake Example"),
        lambda _: None,
    )
    assert (outcome.status, outcome.feed.kind, outcome.feed.url) == (
        "ingested",
        "bibliocommons",
        library_world.GATEWAY,
    )
    assert outcome.detail == "bibliocommons feed (1 of 2 locations in town)"
    assert [event.title for event in outcome.events] == ["Lego Club"]
    assert outcome.skipped == {"cancelled": 1}


def test_bibliocommons_catalog_without_events_falls_back_to_other_discovery():
    table = library_world.biblio_routes()
    table[f"{library_world.GATEWAY}/events/search?limit=1"] = httpx.Response(
        200, json=library_world.biblio_events()
    )
    outcome = library_events.run(
        httpx.Client(transport=library_world.transport(table)), library_world.COUNTY_HOME
    )
    assert outcome.status == "no_feed"
