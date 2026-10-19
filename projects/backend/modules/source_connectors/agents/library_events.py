"""Library events agent: find a supported event feed from a library website, then parse it.

Discovery checks the homepage and up to MAX_CANDIDATE_PAGES linked events/calendar pages
for, in order: an embedded Trumba calendar, an iCalendar link, a BiblioCommons events
library (homepage only, confirmed by the gateway having events), schema.org Event JSON-LD.
There is no free-form scraping and no model extraction; if nothing supported is found the
outcome says so and lists the pages checked.
"""

import logging
import re
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpx

from projects.backend.modules.source_connectors.connectors import (
    bibliocommons,
    ical,
    jsonld,
    trumba_rss,
)
from projects.backend.modules.source_connectors.connectors.common import (
    MAX_FEED_BYTES,
    EventFacts,
    FeedFormatError,
    https_link,
)

logger = logging.getLogger(__name__)
USER_AGENT = "Newsbee-LocalPrototype/0.1 (local library event evaluation)"
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_REDIRECTS = 3
MAX_CANDIDATE_PAGES = 3
PARSERS = {"trumba_rss": trumba_rss.parse, "ical": ical.parse, "jsonld": jsonld.parse}
TRUMBA_SPUD = re.compile(
    r"Trumba\.addSpud\(\s*\{[^}]*?webName\s*:\s*[\"']([A-Za-z0-9_-]{1,64})[\"']", re.S
)
EVENT_LINK = re.compile(r"event|calendar", re.I)


class DiscoveryBlockedError(RuntimeError):
    pass


@dataclass
class Feed:
    kind: str
    url: str
    page: str


@dataclass
class Outcome:
    status: str
    detail: str
    feed: Feed | None = None
    pages_checked: list[str] = field(default_factory=list)
    events: list[EventFacts] = field(default_factory=list)
    skipped: Counter = field(default_factory=Counter)
    response: bytes | None = None


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, dict]] = []
        self.anchor: dict | None = None

    def handle_starttag(self, tag, attrs) -> None:
        values = {key: value or "" for key, value in attrs}
        if tag == "link":
            self.links.append(("link", values))
        elif tag == "a":
            self.anchor = {**values, "text": ""}
            self.links.append(("a", self.anchor))

    def handle_data(self, data) -> None:
        if self.anchor is not None:
            self.anchor["text"] += data

    def handle_endtag(self, tag) -> None:
        if tag == "a":
            self.anchor = None


class Fetcher:
    """HTTPS-only GETs with bounded size, bounded redirects and robots.txt checks."""

    def __init__(self, client: httpx.Client) -> None:
        self.client = client
        self.robots: dict[str, RobotFileParser] = {}

    def allowed(self, url: str) -> bool:
        origin = f"https://{urlsplit(url).netloc}"
        if origin not in self.robots:
            rules = RobotFileParser()
            response = self.client.get(f"{origin}/robots.txt", headers={"User-Agent": USER_AGENT})
            if response.status_code in {401, 403} or response.status_code >= 500:
                rules.disallow_all = True
            elif response.status_code >= 300:
                rules.allow_all = True
            else:
                rules.parse(response.text.splitlines())
            self.robots[origin] = rules
        return self.robots[origin].can_fetch(USER_AGENT, url)

    def get(self, url: str, limit: int, accept: str) -> tuple[str, bytes]:
        for _ in range(MAX_REDIRECTS + 1):
            if https_link(url) is None:
                raise FeedFormatError(f"Refusing non-HTTPS URL: {url}")
            if not self.allowed(url):
                raise DiscoveryBlockedError(f"robots.txt disallows {url}")
            with self.client.stream(
                "GET", url, headers={"User-Agent": USER_AGENT, "Accept": accept}
            ) as response:
                if response.is_redirect:
                    url = urljoin(url, response.headers.get("location", ""))
                    continue
                response.raise_for_status()
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > limit:
                        raise FeedFormatError(f"Response exceeds {limit // (1024 * 1024)} MiB")
                    chunks.append(chunk)
                return url, b"".join(chunks)
        raise FeedFormatError(f"More than {MAX_REDIRECTS} redirects")


def find_feed(html: str, page: str) -> Feed | None:
    spud = TRUMBA_SPUD.search(html)
    if spud:
        url = f"https://www.trumba.com/calendars/{spud.group(1)}.rss?weeks=1"
        return Feed("trumba_rss", url, page)
    parser = LinkParser()
    parser.feed(html)
    for tag, attrs in parser.links:
        href = attrs.get("href", "").strip()
        calendar = (tag == "link" and attrs.get("type", "").lower() == "text/calendar") or (
            tag == "a" and re.search(r"\.ics(\?|$)", href, re.I)
        )
        if href and calendar:
            url = https_link(urljoin(page, re.sub(r"^webcal://", "https://", href, flags=re.I)))
            if url:
                return Feed("ical", url, page)
    if any(jsonld.find_events(block) for block in jsonld.json_ld_blocks(html)):
        return Feed("jsonld", page, page)
    return None


def candidate_pages(html: str, page: str) -> list[str]:
    """Same-site links whose path or text mentions events or a calendar."""
    site = urlsplit(page).hostname.removeprefix("www.")
    parser = LinkParser()
    parser.feed(html)
    found = []
    for tag, attrs in parser.links:
        if tag != "a":
            continue
        url = https_link(urljoin(page, attrs.get("href", "")))
        if url is None:
            continue
        parts = urlsplit(url)
        host = parts.hostname.removeprefix("www.")
        same_site = host == site or host.endswith("." + site)
        if same_site and (EVENT_LINK.search(parts.path) or EVENT_LINK.search(attrs["text"])):
            found.append(url.split("#")[0])
    ranked = sorted(dict.fromkeys(found), key=lambda url: not EVENT_LINK.search(urlsplit(url).path))
    return [url for url in ranked if url.rstrip("/") != page.rstrip("/")][:MAX_CANDIDATE_PAGES]


def bibliocommons_feed(fetcher: "Fetcher", html: str, page: str) -> Feed | None:
    slug = bibliocommons.find_slug(html)
    if slug is None:
        return None
    url = bibliocommons.GATEWAY.format(slug=slug)
    _, content = fetcher.get(f"{url}/events/search?limit=1", MAX_FEED_BYTES, "application/json")
    return Feed("bibliocommons", url, page) if bibliocommons.event_count(content) else None


def discover(fetcher: Fetcher, website: str) -> tuple[Feed | None, list[str]]:
    checked: list[str] = []
    page, content = fetcher.get(website, MAX_PAGE_BYTES, "text/html")
    html = content.decode("utf-8", "replace")
    checked.append(page)
    feed = find_feed(html, page)
    if feed and feed.kind != "jsonld":
        return feed, checked
    feed = bibliocommons_feed(fetcher, html, page) or feed
    if feed:
        return feed, checked
    for candidate in candidate_pages(html, page):
        try:
            final, content = fetcher.get(candidate, MAX_PAGE_BYTES, "text/html")
        except (DiscoveryBlockedError, FeedFormatError, httpx.HTTPStatusError) as error:
            if isinstance(error, httpx.HTTPStatusError) and _retryable(error):
                raise
            checked.append(f"{candidate} ({error})")
            continue
        checked.append(final)
        feed = find_feed(content.decode("utf-8", "replace"), final)
        if feed:
            return feed, checked
    return None, checked


def run(
    client: httpx.Client,
    website: str | None,
    window: tuple[str, str] | None = None,
    wanted: Callable[[str], bool] = lambda venue: True,
    sleep: Callable[[float], None] = time.sleep,
) -> Outcome:
    """Transport errors and HTTP 429/5xx propagate so the job can retry; others are outcomes.

    `window` and `wanted` let API-backed feeds filter server-side; file feeds ignore them
    and the pipeline filters afterwards either way.
    """
    if not website:
        return Outcome("unresolved_website", "No official website recorded at onboarding")
    fetcher = Fetcher(client)
    feed, checked = None, []
    detail = None
    try:
        feed, checked = discover(fetcher, website)
        if feed is None:
            return Outcome("no_feed", "No supported event feed found", pages_checked=checked)
        if feed.kind == "bibliocommons":
            first = date.today() + timedelta(days=1)
            window = window or (first.isoformat(), (first + timedelta(days=6)).isoformat())
            events, skipped, content, detail = bibliocommons.fetch(
                lambda url: fetcher.get(url, MAX_FEED_BYTES, "application/json")[1],
                urlsplit(feed.url).path.rsplit("/", 1)[-1],
                window,
                wanted,
                sleep,
            )
        else:
            _, content = fetcher.get(
                feed.url, MAX_FEED_BYTES, "application/rss+xml, text/calendar, text/html"
            )
            events, skipped = PARSERS[feed.kind](content)
    except DiscoveryBlockedError as error:
        return Outcome("blocked", str(error), feed, checked)
    except (FeedFormatError, httpx.HTTPStatusError) as error:
        if isinstance(error, httpx.HTTPStatusError) and _retryable(error):
            raise
        return Outcome("failed", f"{type(error).__name__}: {error}", feed, checked)
    logger.info(
        "Library feed parsed kind=%s url=%s events=%s skipped=%s",
        feed.kind,
        feed.url,
        len(events),
        dict(skipped),
    )
    return Outcome(
        "ingested", detail or f"{feed.kind} feed", feed, checked, events, skipped, content
    )


def _retryable(error: httpx.HTTPStatusError) -> bool:
    return error.response.status_code == 429 or error.response.status_code >= 500
