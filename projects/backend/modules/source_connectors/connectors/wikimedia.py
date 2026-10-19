"""Wikimedia pageviews REST API (wikimedia.org/api/rest_v1): what readers are looking up.

Only the REST API on wikimedia.org is used; en.wikipedia.org robots.txt disallows /w/ and
/api/, and the Wikidata SPARQL endpoint times out too often to rely on. Data is CC0.
"""

import json
from datetime import date, timedelta
from statistics import mean
from urllib.parse import quote

from projects.backend.modules.source_connectors.connectors.common import (
    FeedFormatError,
    check_size,
)

BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews"
PROJECT = "en.wikipedia"
# Main page, special pages and other namespaces are never topics.
NAMESPACES = ("Special:", "Wikipedia:", "File:", "Portal:", "Help:", "Category:", "Talk:",
              "Template:", "User:", "Draft:", "Module:")


def top_url(day: date) -> str:
    return f"{BASE}/top/{PROJECT}/all-access/{day:%Y/%m/%d}"


def daily_url(article: str, first: date, last: date) -> str:
    title = quote(article.replace(" ", "_"), safe="")
    return (
        f"{BASE}/per-article/{PROJECT}/all-access/user/{title}/daily/"
        f"{first:%Y%m%d}00/{last:%Y%m%d}00"
    )


def article_url(article: str) -> str:
    return f"https://en.wikipedia.org/wiki/{quote(article.replace(' ', '_'), safe='(),')}"


def label(article: str) -> str:
    return article.replace("_", " ")


def topic(article: str) -> bool:
    return article != "Main_Page" and not article.startswith(NAMESPACES)


def _json(content: bytes):
    check_size(content)
    try:
        return json.loads(content)["items"]
    except (ValueError, KeyError, TypeError) as error:
        raise FeedFormatError(f"Pageviews response is not the expected JSON: {error}") from error


def parse_top(content: bytes) -> list[dict]:
    """A daily top list -> [{article, views, rank}] (about 1,000 most-read articles)."""
    items = _json(content)
    articles = items[0]["articles"] if items else []
    return [
        {"article": a["article"], "views": int(a["views"]), "rank": int(a["rank"])}
        for a in articles
        if isinstance(a, dict) and "article" in a and topic(a["article"])
    ]


def parse_daily(content: bytes) -> dict[str, int]:
    """Per-article daily views -> {YYYYMMDD: views}."""
    return {item["timestamp"][:8]: int(item["views"]) for item in _json(content)}


def spike(daily: dict[str, int], recent_days: int = 3) -> dict:
    """Recent average views against the average of the days before (the baseline)."""
    days = sorted(daily)
    recent, baseline = days[-recent_days:], days[:-recent_days]
    recent_mean = mean(daily[d] for d in recent) if recent else 0
    baseline_mean = mean(daily[d] for d in baseline) if baseline else 0
    return {
        "recent_daily_views": round(recent_mean),
        "baseline_daily_views": round(baseline_mean),
        "ratio": round(recent_mean / max(baseline_mean, 1), 2),
        "latest_day": days[-1] if days else None,
    }


def recent_days(today: date, lag: int = 1, span: int = 17) -> tuple[date, date]:
    last = today - timedelta(days=lag)
    return last - timedelta(days=span - 1), last
