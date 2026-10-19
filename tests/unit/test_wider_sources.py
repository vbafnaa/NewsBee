"""Wider-area connectors (USGS, state newsrooms, Wikipedia, Bluesky): adapters, agents,
guardrails and per-topic ranking, all against fake transports."""

import json
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from urllib.parse import unquote

import httpx
import pytest

from projects.backend.modules.editions import stories
from projects.backend.modules.source_connectors import ranking
from projects.backend.modules.source_connectors.agents import (
    hazards,
    regions,
    state_news,
    trending,
)
from projects.backend.modules.source_connectors.connectors import bluesky, usgs, wikimedia
from projects.backend.modules.source_connectors.connectors.common import FeedFormatError
from projects.backend.modules.source_connectors.connectors.news import (
    mentions,
    parse_feed,
    sensitive,
)
from projects.backend.modules.source_connectors.pipelines import events

TODAY = date(2026, 10, 19)
LOCATION = {
    "id": "auburn-wa",
    "name": "Auburn, WA",
    "systems": [{"latitude": 47.3073, "longitude": -122.2285}],
}
STATES = {
    "WA": {
        "name": "Washington",
        "place_suffix": ", Washington",
        "aliases": ["Washington state", "Seattle Seahawks"],
        "ambiguous_places": ["Auburn", "Kent"],
        "locations": {"auburn-wa": {"county": "King County"}},
        "places": {
            "Seattle": [47.6062, -122.3321],
            "Kent": [47.3809, -122.2348],
            "Mount Rainier": [46.8523, -121.7603],
        },
        "newsrooms": [
            {"name": "Governor", "feed": "https://gov.example/rss.xml"},
            {"name": "WSDOT", "feed": "https://dot.example/rss.xml"},
        ],
        "watchlist": [
            {"article": "Mount_Rainier", "about": "Mount Rainier is the state's tallest peak.",
             "place": "Mount Rainier"},
            {"article": "Seattle_Seahawks", "about": "The Seahawks are Washington's NFL team.",
             "place": "Seattle"},
        ],
    }
}


def rfc822(day: date) -> str:
    return datetime.combine(day, datetime.min.time(), UTC).strftime("%a, %d %b %Y %H:%M:%S GMT")


def rss(*items: tuple[str, str, date, str]) -> bytes:
    body = "".join(
        f"<item><title>{title}</title><link>{link}</link><pubDate>{rfc822(day)}</pubDate>"
        f"<description>{summary}</description></item>"
        for title, link, day, summary in items
    )
    return f'<?xml version="1.0"?><rss version="2.0"><channel>{body}</channel></rss>'.encode()


def client(routes: dict, seen: list | None = None) -> httpx.Client:
    """Routes match on URL prefix; robots.txt and unknown URLs are 404 (allow-all)."""

    def respond(request: httpx.Request) -> httpx.Response:
        url = unquote(str(request.url))
        if seen is not None:
            seen.append(url)
        for prefix, reply in routes.items():
            if url.startswith(prefix):
                if isinstance(reply, int):
                    return httpx.Response(reply)
                return httpx.Response(200, content=reply)
        return httpx.Response(404)

    return httpx.Client(transport=httpx.MockTransport(respond))


# Adapters -------------------------------------------------------------------------------


def test_parse_feed_reads_rss_and_atom_newest_first_and_drops_unusable_items():
    content = rss(
        ("Older post.", "https://a.example/1", date(2026, 10, 1), "<p>Old</p>"),
        ("Newer post", "https://a.example/2", date(2026, 10, 10), "New &amp; useful"),
        ("No HTTPS", "http://a.example/3", date(2026, 10, 10), ""),
        ("Duplicate", "https://a.example/2", date(2026, 10, 9), ""),
    )
    items = parse_feed(content)
    assert [item["title"] for item in items] == ["Newer post", "Older post"]
    assert items[0]["summary"].startswith("New & useful") and items[1]["summary"] != "<p>Old</p>"
    atom = (
        b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom item</title>'
        b'<link href="https://b.example/x"/><id>tag:x</id>'
        b"<updated>2026-10-12T08:00:00Z</updated><summary>Hi</summary></entry></feed>"
    )
    [entry] = parse_feed(atom)
    assert (entry["id"], entry["link"], entry["published"].day) == (
        "tag:x", "https://b.example/x", 12)


def test_parse_feed_rejects_unsafe_or_broken_xml():
    with pytest.raises(FeedFormatError):
        parse_feed(b'<!DOCTYPE x [<!ENTITY a "b">]><rss><channel></channel></rss>')
    with pytest.raises(FeedFormatError):
        parse_feed(b"<rss><channel>")


def test_sensitive_and_mentions_guardrails():
    assert sensitive("Man arrested after shooting") and sensitive(None, "Two people died")
    assert not sensitive("Ferry schedule changes for winter")
    assert mentions("New park opens in Auburn.", "auburn")
    assert not mentions("Auburndale fair", "Auburn") and not mentions(None, "Auburn")


def test_usgs_parse_keeps_quakes_with_distance():
    content = json.dumps({"features": [
        {"id": "uw1", "geometry": {"coordinates": [-122.25, 47.32, 12.3]},
         "properties": {"mag": 3.4, "place": "3 km N of Auburn, Washington",
                        "time": 1760000000000, "felt": 25, "status": "reviewed",
                        "url": "https://earthquake.usgs.gov/earthquakes/eventpage/uw1",
                        "type": "earthquake"}},
        {"id": "blast", "geometry": {"coordinates": [-122.2, 47.3, 0]},
         "properties": {"mag": 2.6, "time": 1760000000000, "type": "quarry blast"}},
        {"id": "bad", "geometry": {}, "properties": {}},
    ]}).encode()
    [quake] = usgs.parse(content, 47.3073, -122.2285)
    assert quake["id"] == "uw1" and quake["felt"] == 25 and quake["reviewed"]
    assert quake["distance_km"] == 2
    assert "minmagnitude=2.5" in usgs.query_url(47.3, -122.2, TODAY, 100, 2.5)


def test_wikimedia_spike_compares_latest_three_days_with_baseline():
    daily = {f"202610{day:02d}": 1000 for day in range(1, 15)}
    daily.update({"20261015": 5000, "20261016": 4000, "20261017": 3000})
    result = wikimedia.spike(daily)
    assert result == {"recent_daily_views": 4000, "baseline_daily_views": 1000,
                      "ratio": 4.0, "latest_day": "20261017"}
    assert wikimedia.recent_days(TODAY) == (date(2026, 10, 2), date(2026, 10, 18))
    assert not wikimedia.topic("Special:Search") and not wikimedia.topic("Main_Page")


def test_bluesky_adapter_keeps_only_aggregate_fields():
    content = json.dumps({"trends": [{
        "topic": "seahawks", "displayName": "Seahawks", "description": "Game recap",
        "category": "sports", "status": "hot", "postCount": 4200,
        "startedAt": "2026-10-18T20:00:00Z", "link": "/profile/trending/seahawks",
        "actors": [{"handle": "someone.bsky.social", "displayName": "A Person"}],
    }]}).encode()
    [trend] = bluesky.parse_trends(content)
    assert "actors" not in trend and "someone" not in json.dumps(trend)
    assert trend["url"] == "https://bsky.app/profile/trending/seahawks"
    since = datetime(2026, 10, 12, tzinfo=UTC)
    posts = {"posts": [
        {"record": {"createdAt": "2026-10-15T00:00:00Z", "text": "private words"}},
        {"record": {"createdAt": "2026-10-01T00:00:00Z"}},
        {"indexedAt": "not a date"},
    ]}
    assert bluesky.count_mentions(json.dumps(posts).encode(), since) == 1


# Regions and config ---------------------------------------------------------------------


def test_region_tiers_and_sections():
    place = regions.region(LOCATION, STATES)
    assert (place.town, place.county, place.state_name) == ("Auburn", "King County", "Washington")
    assert place.nearby == ("Kent", "Seattle"), "Mount Rainier is over 50 km away"
    assert [entry["article"] for entry in place.nearby_topics] == ["Seattle_Seahawks"]
    assert place.tier_for("Auburn, WA road closure") == "local"
    assert place.tier_for("A King County levy") == "region"
    assert place.tier_for("Seattle ferry delays") == "nearby"
    assert place.tier_for("Statewide burn ban") is None
    # Names shared with places elsewhere need the state or county, unless the source is
    # already in-state.
    assert place.tier_for("Auburn Tigers win") is None
    assert place.tier_for("Auburn road closure", qualified=True) == "local"
    assert place.tier_for("Kent street fair") is None
    assert place.tier_for("Kent street fair", qualified=True) == "nearby"
    assert place.section("local") == "Auburn in the news"
    assert place.section("region") == "Around King County"
    assert place.section("nearby") == "Near Auburn"
    assert not regions.region({**LOCATION, "id": "x-or"}, STATES).configured


def test_reviewed_state_config_is_valid_and_covers_onboarded_locations(tmp_path):
    states = regions.load()
    wa = states["WA"]
    assert all(feed["feed"].startswith("https://") for feed in wa["newsrooms"])
    for location_id in ("auburn-wa", "bainbridge-island-wa", "edmonds-wa", "issaquah-wa",
                        "vancouver-wa"):
        assert wa["locations"][location_id]["county"].endswith("County")
        assert wa["locations"][location_id]["point"]
    assert all(entry["place"] in wa["places"] for entry in wa["watchlist"])
    vancouver = regions.region({"id": "vancouver-wa", "name": "Vancouver, WA"}, states)
    assert "Portland" in vancouver.nearby and "Seattle" not in vancouver.nearby
    assert not vancouver.nearby_topics
    bad = tmp_path / "states.json"
    bad.write_text(json.dumps({"WA": {"name": "W", "newsrooms": [
        {"name": "x", "feed": "http://insecure.example"}]}}))
    with pytest.raises(ValueError, match="HTTPS"):
        regions.load(bad)


# Agents ---------------------------------------------------------------------------------


def test_hazards_keeps_noticeable_quakes_and_tiers_by_distance():
    def feature(identity, mag, lon, lat, felt=0):
        return {"id": identity, "geometry": {"coordinates": [lon, lat, 10]},
                "properties": {"mag": mag, "place": f"near {identity}", "felt": felt,
                               "time": 1760800000000, "status": "automatic",
                               "url": f"https://earthquake.usgs.gov/{identity}"}}

    content = json.dumps({"features": [
        feature("near", 3.1, -122.23, 47.31),
        feature("far", 3.6, -122.0, 47.5),
        feature("too_far", 4.0, -121.5, 47.6),
        feature("small", 2.6, -122.23, 47.31),
        feature("felt", 2.7, -122.3, 47.35, felt=40),
    ]}).encode()
    record, facts = hazards.collect(
        LOCATION, client({"https://earthquake.usgs.gov/": content}), TODAY, STATES
    )
    assert record["status"] == "ingested" and record["event_count"] == 3
    by_id = {fact.source_event_id: fact for fact in facts}
    assert set(by_id) == {"near", "far", "felt"}
    assert by_id["near"].tier == "local" and by_id["far"].tier == "nearby"
    assert "may be revised" in by_id["near"].description
    assert record["skipped_unusable"] == {"below_threshold": 1, "too_far": 1}


def test_hazards_degrades_without_coordinates_or_when_blocked():
    record, facts = hazards.collect({**LOCATION, "systems": []}, client({}), TODAY, STATES)
    assert (record["status"], facts) == ("no_feed", [])
    blocked = {"https://earthquake.usgs.gov/robots.txt": b"User-agent: *\nDisallow: /"}
    record, _ = hazards.collect(LOCATION, client(blocked), TODAY, STATES)
    assert record["status"] == "blocked"
    record, _ = hazards.collect(
        LOCATION, client({"https://earthquake.usgs.gov/fdsnws": 503}), TODAY, STATES
    )
    assert record["status"] == "failed"


def test_state_news_filters_window_and_sensitive_items_and_tiers_by_place():
    recent, old = TODAY - timedelta(days=2), TODAY - timedelta(days=30)
    routes = {
        "https://gov.example/rss.xml": rss(
            ("Grants open for Auburn small businesses", "https://gov.example/1", recent, ""),
            ("Governor appoints judge", "https://gov.example/2", recent, "King County seat"),
            ("Suspect arrested in Tacoma", "https://gov.example/3", recent, ""),
            ("Statewide burn ban begins", "https://gov.example/5", recent, ""),
            ("Ferry schedule changes in Seattle", "https://gov.example/6", recent, ""),
            ("Trade agreement signed", "https://gov.example/7", recent, "At a Seattle museum."),
            ("Old announcement", "https://gov.example/4", old, ""),
        ),
        "https://dot.example/rss.xml": 500,
    }
    record, facts = state_news.collect(LOCATION, client(routes), TODAY, STATES)
    assert record["status"] == "ingested" and record["source_id"] == "statenews:wa"
    assert [(fact.title, fact.tier) for fact in facts] == [
        ("Grants open for Auburn small businesses", "local"),
        ("Governor appoints judge", "region"),
        ("Ferry schedule changes in Seattle", "nearby"),
    ]
    assert facts[1].section == "Around King County" and facts[0].venue == "Governor"
    assert facts[2].section == "Near Auburn"
    assert record["skipped_unusable"] == {"sensitive_topic": 1, "not_near_town": 2}
    assert record["skipped_outside_window"] == 1
    assert any("HTTPStatusError" in page for page in record["pages_checked"])


def test_state_news_fails_only_when_every_newsroom_fails():
    record, facts = state_news.collect(LOCATION, client({}), TODAY, STATES)
    assert (record["status"], facts) == ("failed", [])
    record, _ = state_news.collect({**LOCATION, "id": "bend-or"}, client({}), TODAY, STATES)
    assert record["status"] == "no_feed"


def pageviews(recent: int, usual: int = 1000) -> bytes:
    first, last = wikimedia.recent_days(TODAY)
    days = [first + timedelta(days=n) for n in range((last - first).days + 1)]
    return json.dumps({"items": [
        {"timestamp": f"{day:%Y%m%d}00", "views": recent if day > last - timedelta(3) else usual}
        for day in days
    ]}).encode()


def wiki_routes(**articles) -> dict:
    base = "https://wikimedia.org/api/rest_v1/metrics/pageviews"
    routes = {
        f"{base}/per-article/en.wikipedia/all-access/user/{name}/": content
        for name, content in articles.items()
    }
    top = {"items": [{"articles": [
        {"article": "Main_Page", "views": 9, "rank": 1},
        {"article": "Kent,_Washington", "views": 9, "rank": 2},
        {"article": "List_of_Washington_state_parks", "views": 9, "rank": 3},
        {"article": "Unrelated_Film", "views": 9, "rank": 4},
    ]}]}
    routes[f"{base}/top/"] = json.dumps(top).encode()
    return routes


def test_wikipedia_trending_qualifies_spikes_and_caches_statewide_calls(tmp_path):
    states = STATES
    routes = wiki_routes(
        Mount_Rainier=pageviews(6000),
        Seattle_Seahawks=pageviews(5000),
        **{"Kent,_Washington": pageviews(3000)},
    )
    routes["https://api.bsky.app/"] = json.dumps({"posts": []}).encode()
    seen: list[str] = []
    record, facts = trending.wikipedia(LOCATION, client(routes, seen), TODAY, tmp_path, states)
    assert record["status"] == "ingested"
    assert [(fact.title, fact.tier, fact.section) for fact in facts] == [
        ("Seattle Seahawks", "nearby", "Trending near Auburn"),
        ("Kent, Washington", "nearby", "Trending near Auburn"),
    ]
    assert record["skipped_unusable"]["not_near_town"] == 1, "Mount Rainier is too far"
    assert facts[0].signals["ratio"] == 5.0 and facts[0].kind == "trending_topic"
    assert "List_of" not in json.dumps([fact.title for fact in facts])
    statewide = [url for url in seen if "Rainier" in url]
    seen.clear()
    trending.wikipedia(LOCATION, client(routes, seen), TODAY, tmp_path, states)
    assert statewide and not [url for url in seen if "Rainier" in url]


def test_wikipedia_trending_fails_cleanly_when_unreachable(tmp_path):
    record, facts = trending.wikipedia(LOCATION, client({}), TODAY, tmp_path, STATES)
    assert (record["status"], facts) == ("failed", [])
    assert not list(tmp_path.iterdir()), "failed statewide results are not cached"


def test_bluesky_trends_keep_nearby_topics_and_drop_statewide_politics_and_sensitive():
    trends = {"trends": [
        {"topic": "a", "displayName": "Seattle Seahawks", "category": "sports",
         "postCount": 5000},
        {"topic": "b", "displayName": "Seattle city budget", "category": "politics",
         "postCount": 9000},
        {"topic": "c", "displayName": "Seattle", "description": "Hiker found dead",
         "category": "other", "postCount": 800},
        {"topic": "d", "displayName": "Seattle sunrise", "postCount": 20},
        {"topic": "f", "displayName": "Auburn", "category": "sports", "postCount": 4000},
        {"topic": "g", "displayName": "Washington state budget", "postCount": 9000},
        {"topic": "h", "displayName": "NFL picks", "description": "Seattle Seahawks lead",
         "postCount": 9000},
        {"topic": "e", "displayName": "Taylor Swift", "postCount": 99999},
    ]}
    routes = {
        "https://api.bsky.app/xrpc/app.bsky.unspecced.getTrends":
            json.dumps(trends).encode(),
        "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts":
            json.dumps({"posts": []}).encode(),
    }
    record, facts = trending.bluesky_trends(LOCATION, client(routes), TODAY, None, STATES)
    assert [(fact.title, fact.tier, fact.kind) for fact in facts] == [
        ("Seattle Seahawks", "nearby", "social_trend")
    ]
    assert record["skipped_unusable"] == {
        "not_near_town": 4, "excluded_topic": 2, "too_few_posts": 1}
    assert "0 posts naming Auburn" in record["detail"]


def test_wider_pipeline_never_raises_even_if_an_agent_crashes(monkeypatch, tmp_path):
    def boom(*args, **kwargs):
        raise RuntimeError("bug")

    monkeypatch.setattr(events.hazards, "collect", boom)
    monkeypatch.setattr(events.regions, "load", lambda: STATES)
    outcomes = events.wider(LOCATION, client({}), TODAY, tmp_path)
    assert [record["source_id"] for record, _ in outcomes][0] == "hazards:usgs"
    assert outcomes[0][0]["status"] == "failed" and outcomes[0][1] == []
    assert len(outcomes) == 4


# Ranking and presentation ---------------------------------------------------------------


def story(title, day="2026-10-15", **facts):
    return SimpleNamespace(title=title, first=SimpleNamespace(event_date=day), facts=facts)


def titles(kind, pool):
    return [item.title for item in ranking.rank(kind, pool)]


def test_hazards_rank_tier_then_magnitude_then_distance():
    pool = [
        story("Far big", tier="region", signals={"magnitude": 4.5, "distance_km": 80}),
        story("Near small", tier="local", signals={"magnitude": 3.0, "distance_km": 5}),
        story("Near bigger", tier="local", signals={"magnitude": 3.2, "distance_km": 20}),
    ]
    assert titles("hazards", pool) == ["Near bigger", "Near small", "Far big"]


def test_state_news_ranks_practical_over_ceremonial_and_interleaves_publishers():
    pool = [
        story("Governor appoints new director", tier="nearby", venue="Governor"),
        story("Lane closures on I-5 this weekend", tier="nearby", venue="WSDOT"),
        story("Bridge paint project", "2026-10-14", tier="nearby", venue="WSDOT"),
        story("Scam warning for consumers", "2026-10-10", tier="nearby", venue="AG"),
        story("King County grant program", "2026-10-01", tier="region", venue="Governor"),
    ]
    assert ranking.source_type("statenews:wa") == "statenews"
    assert titles("statenews", pool) == [
        "King County grant program",
        "Lane closures on I-5 this weekend",
        "Scam warning for consumers",
        "Governor appoints new director",
        "Bridge paint project",
    ]


def test_trending_ranks_tier_then_strength_and_interleaves_sources():
    pool = [
        story("Big wiki", tier="nearby", kind="trending_topic", signals={"ratio": 6.0}),
        story("Small wiki", tier="nearby", kind="trending_topic", signals={"ratio": 2.0}),
        story("Social", tier="nearby", kind="social_trend", signals={"post_count": 300}),
        story("Town wiki", tier="local", kind="trending_topic", signals={"ratio": 1.6}),
    ]
    assert ranking.source_type("trending:bluesky:wa") == "trending"
    assert titles("trending", pool) == ["Town wiki", "Big wiki", "Social", "Small wiki"]


def test_when_where_for_news_names_the_source_and_date():
    [item] = stories.collapse([{"source_id": "statenews:wa", "facts": {
        "source_event_id": "x", "title": "Ferry update", "event_date": "2026-10-15",
        "schedule_text": "Thursday, October 15, 2026", "venue": "WSDOT", "room": None,
        "source_url": "https://wsdot.example/x", "description": "d", "kind": "state_news",
        "tier": "nearby", "section": "Near Auburn",
    }}])
    assert stories.when_where(item) == "Published Thursday, October 15 by WSDOT."
