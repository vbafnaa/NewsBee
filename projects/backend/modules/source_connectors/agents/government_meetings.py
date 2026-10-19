"""Government meetings agent: find a town's meeting platform once, then pull only recent meetings.

Onboarding resolves the town's official website (Wikidata P856, like library websites) and
looks on its homepage and up to MAX_CANDIDATE_PAGES linked agenda/meeting pages for a link
to a supported platform. If none is linked, it tries tenant names guessed from the website
domain and from the town name plus state. Every tenant is confirmed with one API call, and
config/government-sources.json can set the platform and tenant for a location instead.

Ingestion makes only date-filtered API calls: agendas for the edition window plus, where the
platform records votes (Legistar), outcomes from the past PAST_DAYS days. The day of
ingestion is skipped because its meetings may not have happened yet.
"""

import hashlib
import json
import logging
import re
from collections import Counter
from collections.abc import Callable
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx

from projects.backend.modules.communities import wikidata
from projects.backend.modules.source_connectors.agents.library_events import (
    MAX_PAGE_BYTES,
    DiscoveryBlockedError,
    Fetcher,
    LinkParser,
    _retryable,
)
from projects.backend.modules.source_connectors.connectors import civicclerk, legistar, meetings
from projects.backend.modules.source_connectors.connectors.common import (
    MAX_FEED_BYTES,
    FeedFormatError,
    https_link,
)
from projects.backend.shared.configuration.settings import ROOT

logger = logging.getLogger(__name__)
USER_AGENT = "Newsbee-LocalPrototype/0.1 (local government meetings evaluation)"
OVERRIDES = ROOT / "config" / "government-sources.json"
PAST_DAYS = 7
MAX_MEETINGS = 25
MAX_CANDIDATE_PAGES = 3
SUPPORTED = ("legistar", "civicclerk")
TENANT = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
PLATFORM_LINKS = {
    "legistar": re.compile(r"\b([a-z0-9][a-z0-9-]{0,62})\.legistar\.com", re.I),
    "civicclerk": re.compile(r"\b([a-z0-9][a-z0-9-]{0,62})\.(?:portal|api)\.civicclerk\.com", re.I),
    "primegov": re.compile(r"\b([a-z0-9][a-z0-9-]{0,62})\.primegov\.com", re.I),
}
NOT_TENANTS = {"webapi", "www", "api", "portal"}
MEETING_LINK = re.compile(r"agenda|meeting|council|minutes|government|legislat", re.I)
INGESTION_STATUS = {
    "unresolved_website": "unresolved_website",
    "no_platform": "no_feed",
    "blocked": "blocked",
    "failed": "failed",
}


def overrides(path: Path = OVERRIDES) -> dict[str, dict]:
    """Reviewed platform and tenant per location id, for towns discovery gets wrong."""
    if not path.exists():
        return {}
    entries = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(entries, dict):
        raise ValueError(f"{path.name} must map location ids to {{platform, tenant}}")
    for key, entry in entries.items():
        if (
            not isinstance(entry, dict)
            or entry.get("platform") not in SUPPORTED
            or not TENANT.match(str(entry.get("tenant", "")))
        ):
            raise ValueError(
                f"{path.name} entry {key} needs a platform ({', '.join(SUPPORTED)}) and a "
                "lowercase tenant name"
            )
    return entries


def source_id(government: dict) -> str:
    return f"meetings:{government.get('platform') or 'none'}:{government.get('tenant') or 'none'}"


def _found(status: str, detail: str, **values) -> dict:
    return {
        "status": status,
        "platform": None,
        "tenant": None,
        "website": None,
        "wikidata_id": None,
        "pages_checked": [],
        **values,
        "detail": detail,
    }


def platform_links(html: str) -> list[tuple[str, str]]:
    found = []
    for platform, pattern in PLATFORM_LINKS.items():
        for match in pattern.finditer(html):
            tenant = match.group(1).lower()
            if tenant not in NOT_TENANTS:
                found.append((platform, tenant))
    return list(dict.fromkeys(found))


def meeting_pages(html: str, page: str) -> list[str]:
    """Same-site links whose path or text mentions agendas, meetings or the council."""
    site = urlsplit(page).hostname.removeprefix("www.")
    parser = LinkParser()
    parser.feed(html)
    found = []
    for tag, attrs in parser.links:
        url = https_link(urljoin(page, attrs.get("href", ""))) if tag == "a" else None
        if url is None:
            continue
        parts = urlsplit(url)
        host = parts.hostname.removeprefix("www.")
        same_site = host == site or host.endswith("." + site)
        if same_site and (MEETING_LINK.search(parts.path) or MEETING_LINK.search(attrs["text"])):
            found.append(url.split("#")[0])
    unique = [url for url in dict.fromkeys(found) if url.rstrip("/") != page.rstrip("/")]
    return unique[:MAX_CANDIDATE_PAGES]


def confirm(fetcher: Fetcher, platform: str, tenant: str) -> bool:
    """One small API call; only a well-formed answer with data confirms the tenant."""
    url = {"legistar": legistar.confirm_url, "civicclerk": civicclerk.confirm_url}[platform]
    try:
        _, content = fetcher.get(url(tenant), MAX_FEED_BYTES, "application/json")
        if platform == "legistar":
            return bool(legistar.parse_events(content))
        return isinstance(json.loads(content).get("value"), list)
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 429:
            raise
        return False
    except (FeedFormatError, ValueError, AttributeError):
        return False


def _choose(fetcher: Fetcher, candidates: list[tuple[str, str]]) -> tuple[str, str] | None:
    for platform, tenant in candidates:
        if platform == "primegov" or confirm(fetcher, platform, tenant):
            return platform, tenant
    return None


def scan(fetcher: Fetcher, website: str, checked: list[str]) -> tuple[str, str] | None:
    page, content = fetcher.get(website, MAX_PAGE_BYTES, "text/html")
    html = content.decode("utf-8", "replace")
    checked.append(page)
    found = _choose(fetcher, platform_links(html))
    for candidate in meeting_pages(html, page) if found is None else []:
        try:
            final, content = fetcher.get(candidate, MAX_PAGE_BYTES, "text/html")
        except (DiscoveryBlockedError, FeedFormatError, httpx.HTTPStatusError) as error:
            if isinstance(error, httpx.HTTPStatusError) and _retryable(error):
                raise
            checked.append(f"{candidate} ({error})")
            continue
        checked.append(final)
        found = _choose(fetcher, platform_links(content.decode("utf-8", "replace")))
        if found:
            break
    return found


def guesses(website: str, profile: dict) -> list[str]:
    label = urlsplit(website).hostname.removeprefix("www.").split(".")[0].lower()
    city = re.sub(r"[^a-z0-9]", "", profile["name"].split(",")[0].lower())
    state = profile["id"].rsplit("-", 1)[-1].lower()
    slugs = [label if len(label) >= 4 else "", f"{city}{state}"]
    return [slug for slug in dict.fromkeys(slugs) if slug and TENANT.match(slug)]


def discover(client: httpx.Client, profile: dict, override: dict | None = None) -> dict:
    """Find and confirm the location's meeting platform. Never raises for network errors:
    a failure is recorded so library onboarding still completes; re-run onboard to retry."""
    if override:
        return _found(
            "override",
            "Platform from config/government-sources.json",
            platform=override["platform"],
            tenant=override["tenant"],
        )
    city = profile["name"].split(",")[0]
    point = next(
        (s for s in profile["systems"] if s.get("latitude") is not None), {"latitude": None}
    )
    try:
        lookup = wikidata.lookup(client, city, point["latitude"], point.get("longitude"))
    except httpx.HTTPError as error:
        return _found("failed", f"Wikidata lookup failed: {type(error).__name__}: {error}")
    website = lookup["website"]
    if not website:
        return _found("unresolved_website", lookup["detail"])
    known = {"website": website, "wikidata_id": lookup["wikidata_id"]}
    fetcher = Fetcher(client, USER_AGENT)
    checked: list[str] = []
    how = "linked from the town website"
    try:
        found = scan(fetcher, website, checked)
        if found is None:
            how = "found under a name guessed from the town"
            found = _choose(
                fetcher, [(p, slug) for slug in guesses(website, profile) for p in SUPPORTED]
            )
    except DiscoveryBlockedError as error:
        return _found("blocked", str(error), pages_checked=checked, **known)
    except (FeedFormatError, httpx.HTTPError) as error:
        detail = f"{type(error).__name__}: {error}"
        return _found("failed", detail, pages_checked=checked, **known)
    if found is None:
        return _found(
            "no_platform",
            "No supported meeting platform (Legistar, CivicClerk) linked from the town "
            "website or found under its name",
            pages_checked=checked,
            **known,
        )
    platform, tenant = found
    values = {"platform": platform, "tenant": tenant, "pages_checked": checked, **known}
    if platform == "primegov":
        url = f"https://{tenant}.primegov.com/api/v2/PublicPortal/ListUpcomingMeetings"
        try:
            allowed = fetcher.allowed(url)
        except httpx.HTTPError as error:
            return _found("failed", f"{type(error).__name__}: {error}", **values)
        if not allowed:
            return _found("blocked", f"PrimeGov robots.txt disallows {url}", **values)
        return _found("no_platform", "PrimeGov is not supported yet", **values)
    return _found("detected", f"{platform} tenant {tenant} {how}", **values)


def _fetch(fetcher: Fetcher) -> Callable[[str], bytes]:
    return lambda url: fetcher.get(url, MAX_FEED_BYTES, "application/json")[1]


def _day(value) -> date:
    return value.date() if isinstance(value, datetime) else value


def _legistar(fetcher, tenant, place, today, window) -> tuple[list, Counter, bytes, str]:
    first, last = today - timedelta(days=PAST_DAYS), date.fromisoformat(window[1])
    upcoming_from = date.fromisoformat(window[0])
    url = legistar.events_url(tenant, first, last)
    content = _fetch(fetcher)(url)
    dated = [(legistar.start(event), event) for event in legistar.parse_events(content)]
    upcoming = sorted(
        (pair for pair in dated if upcoming_from <= _day(pair[0]) <= last),
        key=lambda pair: str(pair[0]),
    )
    recent = sorted(
        (pair for pair in dated if first <= _day(pair[0]) < today),
        key=lambda pair: str(pair[0]),
        reverse=True,
    )
    skipped = Counter({"outside_window": len(dated) - len(upcoming) - len(recent)})
    facts, fetched = [], 0
    for start, event in upcoming + recent:
        if legistar.is_cancelled(event):
            skipped["cancelled"] += 1
            continue
        if fetched >= MAX_MEETINGS:
            skipped["over_limit"] += 1
            continue
        fetched += 1
        meeting = legistar.meeting(tenant, event, _fetch(fetcher))
        past = _day(start) < today
        made = meetings.outcome(meeting, place) if past else meetings.preview(meeting, place)
        if made is None:
            skipped["no_recorded_outcomes" if past else "no_substantive_agenda"] += 1
        else:
            facts.append(made)
    return facts, +skipped, content, url


def _civicclerk(fetcher, tenant, place, today, window) -> tuple[list, Counter, bytes, str]:
    first, last = date.fromisoformat(window[0]), date.fromisoformat(window[1])
    url = civicclerk.events_url(tenant, first, last + timedelta(days=1))
    content = _fetch(fetcher)(url)
    events = civicclerk.parse_events(content)
    skipped, facts = Counter(), []
    for event in sorted(events, key=civicclerk.start):
        if not first <= civicclerk.start(event).date() <= last:
            skipped["outside_window"] += 1
        elif meetings.cancelled(event.get("eventName")):
            skipped["cancelled"] += 1
        elif not civicclerk.usable(event):
            skipped["agenda_not_posted"] += 1
        elif len(facts) + skipped["no_substantive_agenda"] >= MAX_MEETINGS:
            skipped["over_limit"] += 1
        else:
            made = meetings.preview(civicclerk.meeting(tenant, event, _fetch(fetcher)), place)
            if made is None:
                skipped["no_substantive_agenda"] += 1
            else:
                facts.append(made)
    return facts, +skipped, content, url


PLATFORMS = {"legistar": _legistar, "civicclerk": _civicclerk}


def collect(
    location: dict, client: httpx.Client, today: date, window: tuple[str, str]
) -> tuple[dict, list[meetings.MeetingFacts]]:
    """Transport errors and HTTP 429/5xx propagate so the job can retry; others are outcomes."""
    government = location["government"]
    place = location["name"].split(",")[0]
    result = {
        "source_id": source_id(government),
        "name": f"{place} public meetings",
        "website": government.get("website"),
        "status": INGESTION_STATUS.get(government["status"], "ingested"),
        "detail": government["detail"],
        "feed_kind": government.get("platform"),
        "feed_url": None,
        "pages_checked": government.get("pages_checked", []),
        "response_sha256": None,
        "event_count": 0,
        "skipped_other_venues": 0,
        "skipped_outside_window": 0,
        "skipped_unusable": {},
        "unmatched_venues": {},
    }
    if government["status"] not in {"detected", "override"}:
        return result, []
    fetcher = Fetcher(client, USER_AGENT)
    facts: list[meetings.MeetingFacts] = []
    try:
        facts, skipped, content, url = PLATFORMS[government["platform"]](
            fetcher, government["tenant"], place, today, window
        )
    except DiscoveryBlockedError as error:
        result.update(status="blocked", detail=str(error))
    except (FeedFormatError, httpx.HTTPStatusError) as error:
        if isinstance(error, httpx.HTTPStatusError) and _retryable(error):
            raise
        result.update(status="failed", detail=f"{type(error).__name__}: {error}")
    else:
        previews = sum(fact.kind == "meeting_preview" for fact in facts)
        result.update(
            status="ingested",
            detail=f"{government['platform']} API: {previews} upcoming agendas, "
            f"{len(facts) - previews} recent outcomes",
            feed_url=url,
            response_sha256=hashlib.sha256(content).hexdigest(),
            event_count=len(facts),
            skipped_outside_window=skipped.pop("outside_window", 0),
            skipped_unusable=dict(skipped),
        )
    logger.info(
        "Government meetings result source_id=%s status=%s meetings=%s skipped=%s detail=%s",
        result["source_id"],
        result["status"],
        len(facts),
        result["skipped_unusable"],
        result["detail"],
    )
    return result, facts
