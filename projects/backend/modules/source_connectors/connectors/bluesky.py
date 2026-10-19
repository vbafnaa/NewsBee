"""Bluesky public AppView (api.bsky.app): aggregate social signals only, never posts.

Posts are written by private individuals, so nothing a person wrote is stored, quoted or
attributed: post search returns only a count of recent mentions, and trending topics keep
only Bluesky's own topic name, summary, category and post count (no handles or actors).
No account or key is needed; X/Twitter, Reddit and TikTok need paid or restricted access.
"""

import json
from datetime import datetime
from urllib.parse import urlencode

from projects.backend.modules.source_connectors.connectors.common import (
    FeedFormatError,
    check_size,
    https_link,
)

BASE = "https://api.bsky.app/xrpc"
MAX_RESULTS = 100


def search_url(query: str, since: datetime) -> str:
    params = {
        "q": query,
        "since": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "limit": MAX_RESULTS,
        "sort": "latest",
        "lang": "en",
    }
    return f"{BASE}/app.bsky.feed.searchPosts?{urlencode(params)}"


def trends_url(limit: int = 25) -> str:
    return f"{BASE}/app.bsky.unspecced.getTrends?limit={limit}"


def _json(content: bytes) -> dict:
    check_size(content)
    try:
        data = json.loads(content)
    except ValueError as error:
        raise FeedFormatError(f"Bluesky response is not JSON: {error}") from error
    if not isinstance(data, dict):
        raise FeedFormatError("Bluesky response is not a JSON object")
    return data


def count_mentions(content: bytes, since: datetime) -> int:
    """Number of returned posts created since `since` (capped at MAX_RESULTS)."""
    count = 0
    for post in _json(content).get("posts") or []:
        created = (post.get("record") or {}).get("createdAt") or post.get("indexedAt")
        try:
            moment = datetime.fromisoformat(str(created).replace("Z", "+00:00"))
        except ValueError:
            continue
        if moment >= since:
            count += 1
    return count


def parse_trends(content: bytes) -> list[dict]:
    """Trending topics with only Bluesky's own labels; actors and handles are dropped."""
    trends = []
    for trend in _json(content).get("trends") or []:
        if not isinstance(trend, dict) or not trend.get("displayName"):
            continue
        link = str(trend.get("link") or "")
        trends.append(
            {
                "topic": str(trend.get("topic") or trend["displayName"]),
                "name": str(trend["displayName"]).strip(),
                "description": str(trend.get("description") or "").strip() or None,
                "category": str(trend.get("category") or "other"),
                "status": str(trend.get("status") or ""),
                "post_count": int(trend.get("postCount") or 0),
                "started_at": str(trend.get("startedAt") or ""),
                "url": https_link(f"https://bsky.app{link}") if link.startswith("/") else None,
            }
        )
    return trends
