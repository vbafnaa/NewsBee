"""Trending agent: what people near the town are paying attention to right now.

Two free, public, keyless sources, each its own adapter and source id:

* Wikipedia (``trending:wikipedia:<state>``): daily views of reviewed state watchlist
  articles (teams, landmarks, ferries, fairs, shows set in the state) plus most-read
  articles whose titles tie them to the state. Only topics about the town, its county or a
  reviewed place within NEARBY_KM are kept. A topic trends when its latest three days
  average at least MIN_RATIO times its usual daily views. The town's and county's own
  articles are measured too, as a local attention signal recorded on the result.
* Bluesky (``trending:bluesky:<state>``): Bluesky's trending topics that name the town,
  county, a nearby place or a nearby watchlist topic. Political topics are excluded. Posts
  are only ever counted.

Statewide results are cached per state per day under the data directory, so every location
in a state shares one set of calls. Guardrails: robots.txt is honoured (Fetcher), call
counts are bounded, sensitive topics (deaths, crime, violence) and lists are dropped, and
writers are told never to guess why something is trending.
"""

import hashlib
import json
import logging
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx

from projects.backend.modules.source_connectors.agents.library_events import (
    DiscoveryBlockedError,
    Fetcher,
)
from projects.backend.modules.source_connectors.agents.regions import (
    USER_AGENT,
    Region,
    region,
    result,
)
from projects.backend.modules.source_connectors.connectors import bluesky, wikimedia
from projects.backend.modules.source_connectors.connectors.common import (
    MAX_FEED_BYTES,
    FeedFormatError,
)
from projects.backend.modules.source_connectors.connectors.news import (
    NewsFacts,
    mentions,
    published_text,
    sensitive,
)

logger = logging.getLogger(__name__)
TOP_DAYS = 3
TOP_LOOKBACK = 6
MAX_MOST_READ = 8
MAX_SOCIAL_LOOKUPS = 3
MAX_ITEMS = 5
MIN_RATIO = 2.0
MIN_RATIO_MOST_READ = 1.5
MIN_VIEWS = 1000
MIN_POSTS = 100
SOCIAL_DAYS = 3
EXCLUDED_CATEGORIES = frozenset({"politics"})
EXCLUDED_PREFIXES = ("List_of", "Lists_of", "Deaths_in", "Timeline_of", "Index_of")
ERRORS = (DiscoveryBlockedError, FeedFormatError, httpx.HTTPError)


def _get_json(fetcher: Fetcher, url: str) -> bytes:
    return fetcher.get(url, MAX_FEED_BYTES, "application/json")[1]


def _cache(cache_dir: Path | None, name: str, build):
    """Read today's cached statewide result, or build and store it."""
    path = cache_dir / name if cache_dir else None
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    value = build()
    if path and not value.get("failed"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2, default=str), encoding="utf-8")
    return value


def state_tied(article: str, place: Region) -> bool:
    title = wikimedia.label(article)
    if place.place_suffix and place.place_suffix in title:
        return True
    return any(mentions(title, alias) for alias in place.aliases)


def allowed(article: str) -> bool:
    return (
        wikimedia.topic(article)
        and not article.startswith(EXCLUDED_PREFIXES)
        and not sensitive(wikimedia.label(article))
    )


def _daily(fetcher: Fetcher, article: str, today: date) -> dict:
    first, last = wikimedia.recent_days(today)
    return wikimedia.spike(wikimedia.parse_daily(_get_json(fetcher, wikimedia.daily_url(
        article, first, last))))


def _social(fetcher: Fetcher, query: str, now: datetime, days: int = SOCIAL_DAYS) -> int | None:
    since = now - timedelta(days=days)
    try:
        return bluesky.count_mentions(_get_json(fetcher, bluesky.search_url(query, since)), since)
    except ERRORS as error:
        logger.info("Bluesky mention count unavailable query=%s error=%s", query, error)
        return None


def wikipedia_statewide(fetcher: Fetcher, place: Region, today: date) -> dict:
    """Watchlist and most-read topics for the state, with spike numbers. Bounded calls:
    one per watchlist article, up to TOP_LOOKBACK top lists, MAX_MOST_READ articles and
    MAX_SOCIAL_LOOKUPS Bluesky counts."""
    topics, errors, top_days = [], [], []
    for entry in place.watchlist:
        try:
            topics.append({**_daily(fetcher, entry["article"], today), "article":
                           entry["article"], "about": entry["about"], "origin": "watchlist"})
        except ERRORS as error:
            errors.append(f"{entry['article']}: {type(error).__name__}")
    most_read: dict[str, dict] = {}
    watched = {entry["article"] for entry in place.watchlist}
    for offset in range(1, TOP_LOOKBACK + 1):
        if len(top_days) == TOP_DAYS:
            break
        day = today - timedelta(days=offset)
        try:
            articles = wikimedia.parse_top(_get_json(fetcher, wikimedia.top_url(day)))
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 404:
                continue  # Pageview data lags a day or two behind.
            errors.append(f"top {day}: {type(error).__name__}")
            continue
        except ERRORS as error:
            errors.append(f"top {day}: {type(error).__name__}")
            continue
        top_days.append(day.isoformat())
        for item in articles:
            if item["article"] in watched or not state_tied(item["article"], place):
                continue
            best = most_read.setdefault(item["article"], {"best_rank": item["rank"]})
            best["best_rank"] = min(best["best_rank"], item["rank"])
    ranked = sorted(most_read.items(), key=lambda pair: pair[1]["best_rank"])[:MAX_MOST_READ]
    for article, best in ranked:
        try:
            topics.append({**_daily(fetcher, article, today), **best, "article": article,
                           "about": None, "origin": "most_read"})
        except ERRORS as error:
            errors.append(f"{article}: {type(error).__name__}")
    trending = sorted(
        (topic for topic in topics if qualifies(topic)), key=lambda t: -t["ratio"]
    )
    now = datetime.combine(today, datetime.min.time(), UTC)
    for topic in trending[:MAX_SOCIAL_LOOKUPS]:
        topic["social_mentions"] = _social(fetcher, f'"{wikimedia.label(topic["article"])}"', now)
    attempted = len(place.watchlist) + len(ranked)
    return {
        "topics": topics,
        "top_days": top_days,
        "errors": errors,
        "failed": attempted > 0 and len(errors) >= attempted,
    }


def qualifies(topic: dict) -> bool:
    minimum = MIN_RATIO if topic["origin"] == "watchlist" else MIN_RATIO_MOST_READ
    return (
        allowed(topic["article"])
        and topic["ratio"] >= minimum
        and topic["recent_daily_views"] >= MIN_VIEWS
    )


def topic_tier(topic: dict, place: Region) -> str | None:
    """Watchlist topics are nearby when their reviewed place is; most-read titles are
    already tied to the state, so ambiguous place names count."""
    tier = place.item_tier(wikimedia.label(topic["article"]), topic["about"], qualified=True)
    if tier is None and any(e["article"] == topic["article"] for e in place.nearby_topics):
        return "nearby"
    return tier


def topic_facts(topic: dict, place: Region) -> NewsFacts:
    name = wikimedia.label(topic["article"])
    views, ratio = topic["recent_daily_views"], topic["ratio"]
    reading = (
        f"Wikipedia readers viewed the {name} article about {views:,} times a day over the "
        f"latest three days, {ratio:g} times its usual daily readership."
    )
    if topic["about"]:
        description = f"{topic['about']} {reading}"
    else:
        description = f"The {name} article was among the most-read on English Wikipedia. {reading}"
    if topic.get("social_mentions"):
        description += (
            f" Bluesky users mentioned it in {topic['social_mentions']} or more recent posts."
        )
    tier = topic_tier(topic, place)
    section = {
        "local": "Trending locally",
        "region": f"Trending around {place.county}",
    }.get(tier, f"Trending near {place.town}")
    day = date.fromisoformat(
        f"{topic['latest_day'][:4]}-{topic['latest_day'][4:6]}-{topic['latest_day'][6:]}"
    )
    return NewsFacts(
        source_event_id=hashlib.sha256(topic["article"].encode()).hexdigest()[:16],
        title=name,
        event_date=day.isoformat(),
        schedule_text=published_text(day),
        venue="Wikipedia page views",
        source_url=wikimedia.article_url(topic["article"]),
        description=description,
        kind="trending_topic",
        tier=tier,
        section=section,
        signals={
            "ratio": ratio,
            "recent_daily_views": views,
            "baseline_daily_views": topic["baseline_daily_views"],
            "origin": topic["origin"],
            **({"best_rank": topic["best_rank"]} if "best_rank" in topic else {}),
        },
        social_mentions=topic.get("social_mentions"),
    )


def wikipedia(location: dict, client: httpx.Client, today: date, cache_dir=None, states=None):
    place = region(location, states)
    record = result(
        f"trending:wikipedia:{place.state_code.lower()}",
        f"Trending in {place.state_name or place.state_code} (Wikipedia)",
        "ingested",
        "",
        feed_kind="wikimedia_pageviews",
        website="https://wikimedia.org/api/rest_v1/",
    )
    if not place.configured:
        record.update(status="no_feed", detail=f"No reviewed watchlist for {place.state_code}")
        return record, []
    fetcher = Fetcher(client, USER_AGENT)
    data = _cache(
        cache_dir,
        f"wikipedia-{place.state_code}-{today.isoformat()}.json",
        lambda: wikipedia_statewide(fetcher, place, today),
    )
    attention = {}
    for label, article in (
        ("town", f"{place.town}{place.place_suffix or ''}"),
        ("county", f"{place.county}{place.place_suffix or ''}" if place.county else None),
    ):
        if article:
            try:
                attention[label] = _daily(fetcher, article.replace(" ", "_"), today)["ratio"]
            except ERRORS:
                attention[label] = None
    if data["failed"]:
        record.update(status="failed", detail="; ".join(data["errors"][:5]))
        return record, []
    trending = sorted(
        (topic for topic in data["topics"] if qualifies(topic)),
        key=lambda topic: -topic["ratio"],
    )
    near = [topic for topic in trending if topic_tier(topic, place)]
    facts = [topic_facts(topic, place) for topic in near[:MAX_ITEMS]]
    record.update(
        detail=f"{len(data['topics'])} topics measured, {len(trending)} trending, "
        f"{len(near)} near {place.town}; top lists "
        f"{', '.join(data['top_days']) or 'unavailable'}; attention vs usual: town "
        f"{attention.get('town')}x, county {attention.get('county')}x",
        event_count=len(facts),
        skipped_unusable={
            key: value
            for key, value in {
                "not_trending": len(data["topics"]) - len(trending),
                "not_near_town": len(trending) - len(near),
            }.items()
            if value
        },
        pages_checked=data["errors"][:10],
    )
    logger.info("Wikipedia trending result source_id=%s topics=%s trending=%s attention=%s",
                record["source_id"], len(data["topics"]), len(facts), attention)
    return record, facts


def trend_tier(trend: dict, place: Region) -> str | None:
    """Bluesky trends are national, so ambiguous names need the state or county named too;
    a nearby place or nearby watchlist topic (e.g. a local team) must be in the trend name
    itself, not just its summary."""
    tier = place.item_tier(trend["name"], trend["description"])
    if tier is None and any(
        mentions(trend["name"], wikimedia.label(entry["article"]))
        for entry in place.nearby_topics
    ):
        return "nearby"
    return tier


def trend_facts(trend: dict, place: Region, today: date) -> NewsFacts:
    description = (
        f"Bluesky lists {trend['name']} as a trending topic, with about "
        f"{trend['post_count']:,} posts."
    )
    if trend["description"]:
        description += f" Bluesky's summary: {trend['description']}"
    tier = trend_tier(trend, place)
    return NewsFacts(
        source_event_id=hashlib.sha256(trend["topic"].encode()).hexdigest()[:16],
        title=trend["name"],
        event_date=today.isoformat(),
        schedule_text=published_text(today),
        venue="Bluesky trending topics",
        source_url=trend["url"] or "https://bsky.app/",
        description=description,
        kind="social_trend",
        tier=tier,
        section="Trending on social media",
        signals={"post_count": trend["post_count"], "category": trend["category"],
                 "status": trend["status"]},
        social_mentions=trend["post_count"],
    )


def bluesky_trends(location: dict, client: httpx.Client, today: date, cache_dir=None,
                   states=None):
    place = region(location, states)
    record = result(
        f"trending:bluesky:{place.state_code.lower()}",
        f"Trending on Bluesky ({place.state_name or place.state_code})",
        "ingested",
        "",
        feed_kind="bluesky_trends",
        website="https://bsky.app/",
        feed_url=bluesky.trends_url(),
    )
    if not place.configured:
        record.update(status="no_feed", detail=f"No reviewed aliases for {place.state_code}")
        return record, []
    fetcher = Fetcher(client, USER_AGENT)

    def build() -> dict:
        try:
            return {"trends": bluesky.parse_trends(_get_json(fetcher, bluesky.trends_url()))}
        except DiscoveryBlockedError as error:
            return {"failed": True, "status": "blocked", "error": str(error)}
        except (FeedFormatError, httpx.HTTPError) as error:
            return {"failed": True, "status": "failed", "error": f"{type(error).__name__}"}

    data = _cache(cache_dir, f"bluesky-trends-{today.isoformat()}.json", build)
    now = datetime.combine(today, datetime.min.time(), UTC)
    town_posts = _social(fetcher, f'"{place.town}" "{place.state_name}"', now, 7)
    if data.get("failed"):
        record.update(status=data["status"], detail=data["error"])
        return record, []
    skipped = {"not_near_town": 0, "excluded_topic": 0, "too_few_posts": 0}
    facts = []
    for trend in data["trends"]:
        text = f"{trend['name']} {trend['description'] or ''}"
        if trend_tier(trend, place) is None:
            skipped["not_near_town"] += 1
        elif trend["category"] in EXCLUDED_CATEGORIES or sensitive(text):
            skipped["excluded_topic"] += 1
        elif trend["post_count"] < MIN_POSTS:
            skipped["too_few_posts"] += 1
        else:
            facts.append(trend_facts(trend, place, today))
    facts = facts[:MAX_ITEMS]
    record.update(
        detail=f"{len(data['trends'])} national trending topics, {len(facts)} about "
        f"{place.town} or nearby; {town_posts if town_posts is not None else 'unknown'} posts "
        f"naming {place.town} in 7 days (counted, not stored)",
        event_count=len(facts),
        skipped_unusable={key: value for key, value in skipped.items() if value},
    )
    logger.info("Bluesky trending result source_id=%s trends=%s kept=%s town_posts=%s",
                record["source_id"], len(data["trends"]), len(facts), town_posts)
    return record, facts
