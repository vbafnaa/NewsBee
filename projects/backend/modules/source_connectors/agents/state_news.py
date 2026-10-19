"""State news agent: the past fortnight's announcements from official state newsrooms.

Feeds come from the reviewed config/state-sources.json (governor, transportation, health,
attorney general and similar public agencies), never from commercial publishers. Items that
name the town are local, its county regional, a reviewed place within NEARBY_KM nearby; the
rest are statewide and dropped, since they are rarely community news.
Crime cases about individuals, deaths and violence are dropped (see news.SENSITIVE).
"""

import hashlib
import logging
from collections import Counter
from datetime import date, timedelta

import httpx

from projects.backend.modules.source_connectors.agents.library_events import (
    DiscoveryBlockedError,
    Fetcher,
)
from projects.backend.modules.source_connectors.agents.regions import USER_AGENT, region, result
from projects.backend.modules.source_connectors.connectors.common import (
    MAX_FEED_BYTES,
    FeedFormatError,
)
from projects.backend.modules.source_connectors.connectors.news import (
    NewsFacts,
    parse_feed,
    published_text,
    sensitive,
)

logger = logging.getLogger(__name__)
PAST_DAYS = 14
MAX_PER_NEWSROOM = 10
ACCEPT = "application/rss+xml, application/atom+xml, application/xml, text/xml"


def source_id(state_code: str) -> str:
    return f"statenews:{state_code.lower()}"


def collect(location: dict, client: httpx.Client, today: date, states=None):
    """Never raises for source problems; each newsroom's failure is recorded separately."""
    place = region(location, states)
    record = result(
        source_id(place.state_code),
        f"{place.state_name or place.state_code} state newsrooms",
        "ingested",
        "",
        feed_kind="rss",
    )
    if not place.configured or not place.newsrooms:
        record.update(status="no_feed", detail=f"No reviewed newsrooms for {place.state_code}")
        return record, []
    fetcher = Fetcher(client, USER_AGENT)
    first = today - timedelta(days=PAST_DAYS)
    facts: list[NewsFacts] = []
    skipped, failures, digest = Counter(), Counter(), hashlib.sha256()
    for newsroom in place.newsrooms:
        try:
            _, content = fetcher.get(newsroom["feed"], MAX_FEED_BYTES, ACCEPT)
            items = parse_feed(content)
        except DiscoveryBlockedError as error:
            failures["blocked"] += 1
            record["pages_checked"].append(f"{newsroom['feed']} ({error})")
            continue
        except (FeedFormatError, httpx.HTTPError) as error:
            failures["failed"] += 1
            record["pages_checked"].append(f"{newsroom['feed']} ({type(error).__name__})")
            continue
        record["pages_checked"].append(newsroom["feed"])
        digest.update(content)
        kept = 0
        for item in items:
            day = item["published"].date()
            if not first <= day <= today:
                skipped["outside_window"] += 1
            elif sensitive(item["title"], item["summary"]):
                skipped["sensitive_topic"] += 1
            elif (tier := place.item_tier(item["title"], item["summary"], qualified=True)) is None:
                skipped["not_near_town"] += 1
            elif kept >= MAX_PER_NEWSROOM:
                skipped["over_limit"] += 1
            else:
                kept += 1
                facts.append(
                    NewsFacts(
                        source_event_id=hashlib.sha256(item["id"].encode()).hexdigest()[:16],
                        title=item["title"],
                        event_date=day.isoformat(),
                        schedule_text=published_text(day),
                        venue=newsroom["name"],
                        source_url=item["link"],
                        description=item["summary"],
                        kind="state_news",
                        tier=tier,
                        section=place.section(tier),
                        signals={"publisher": newsroom["name"]},
                    )
                )
    ok = len(place.newsrooms) - sum(failures.values())
    if ok == 0:
        record["status"] = "blocked" if failures["blocked"] and not failures["failed"] else "failed"
    tiers = Counter(fact.tier for fact in facts)
    record.update(
        detail=f"{ok}/{len(place.newsrooms)} newsrooms read; {len(facts)} items in "
        f"{PAST_DAYS} days near {place.town} ({tiers['local']} name the town, {tiers['region']} "
        f"the county, {tiers['nearby']} a nearby place)",
        response_sha256=digest.hexdigest() if ok else None,
        event_count=len(facts),
        skipped_outside_window=skipped.pop("outside_window", 0),
        skipped_unusable=dict(skipped),
    )
    logger.info(
        "State news result source_id=%s status=%s items=%s tiers=%s skipped=%s",
        record["source_id"],
        record["status"],
        len(facts),
        dict(tiers),
        record["skipped_unusable"],
    )
    return record, facts
