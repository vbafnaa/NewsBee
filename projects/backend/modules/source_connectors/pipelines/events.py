"""Ingest one onboarded location: run the library events agent for every library system,
keep only next-7-day events at an in-town branch, add the town's public meetings (upcoming
agendas plus the past week's recorded outcomes), and store facts plus evidence.

With NEWSBEE_WIDER_SOURCES on (the default), also add the past fortnight's nearby
earthquakes, official state newsroom posts, and Wikipedia/Bluesky trends about the town, its
county or places within 50 km (statewide items are dropped), each tagged local/region/nearby
so drafting can fill news-desert editions without crowding out town news."""

import hashlib
import json
import logging
import sqlite3
import time
import uuid
from collections import Counter
from datetime import UTC, date, datetime, timedelta

import httpx

from projects.backend.modules.communities import locations
from projects.backend.modules.communities.venues import match_branch
from projects.backend.modules.orchestration import jobs
from projects.backend.modules.source_connectors.agents import (
    government_meetings,
    hazards,
    library_events,
    regions,
    state_news,
    trending,
)
from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.storage import snapshots
from projects.backend.shared.storage.database import connect

logger = logging.getLogger(__name__)
WINDOW_DAYS = 7
UNMATCHED_SAMPLE = 10


def source_id(system: dict) -> str:
    return f"library:{system['fscskey']}"


def window(today: date) -> tuple[str, str]:
    """The next WINDOW_DAYS days, starting tomorrow so no event has already happened."""
    first = today + timedelta(days=1)
    return first.isoformat(), (first + timedelta(days=WINDOW_DAYS - 1)).isoformat()


def collect(system: dict, client: httpx.Client, start: str, end: str) -> tuple[dict, list]:
    outcome = library_events.run(
        client,
        system.get("website"),
        (start, end),
        lambda venue: match_branch(venue, system["branches"]) is not None,
    )
    kept, unmatched, outside = [], Counter(), 0
    for event in outcome.events:
        if not start <= event.event_date <= end:
            outside += 1
            continue
        branch = match_branch(event.venue, system["branches"])
        if branch is None:
            unmatched[event.venue] += 1
            continue
        kept.append((event, branch))
    if unmatched:
        logger.info(
            "Events skipped at venues outside the location fscskey=%s venues=%s",
            system["fscskey"],
            dict(unmatched.most_common(UNMATCHED_SAMPLE)),
        )
    result = {
        "source_id": source_id(system),
        "name": system["name"],
        "website": system.get("website"),
        "status": outcome.status,
        "detail": outcome.detail,
        "feed_kind": outcome.feed.kind if outcome.feed else None,
        "feed_url": outcome.feed.url if outcome.feed else None,
        "pages_checked": outcome.pages_checked,
        "response_sha256": (
            hashlib.sha256(outcome.response).hexdigest() if outcome.response else None
        ),
        "event_count": len(kept),
        "skipped_other_venues": sum(unmatched.values()),
        "skipped_outside_window": outside,
        "skipped_unusable": dict(outcome.skipped),
        "unmatched_venues": dict(unmatched.most_common(UNMATCHED_SAMPLE)),
    }
    logger.info(
        "Library system result source_id=%s status=%s events=%s skipped_other_venues=%s "
        "skipped_outside_window=%s detail=%s",
        result["source_id"],
        outcome.status,
        len(kept),
        result["skipped_other_venues"],
        outside,
        outcome.detail,
    )
    return result, kept


def wider(location: dict, client: httpx.Client, today: date, cache_dir) -> list[tuple]:
    """Nearby hazards, state newsroom posts and trends near the town, so news deserts still get an
    edition. Each returns its own result; none of them fails the location's job."""
    states = regions.load()
    collectors = (
        ("hazards:usgs", "USGS earthquakes nearby", lambda: hazards.collect(
            location, client, today, states)),
        ("statenews", "State newsrooms", lambda: state_news.collect(
            location, client, today, states)),
        ("trending:wikipedia", "Trending on Wikipedia", lambda: trending.wikipedia(
            location, client, today, cache_dir, states)),
        ("trending:bluesky", "Trending on Bluesky", lambda: trending.bluesky_trends(
            location, client, today, cache_dir, states)),
    )
    outcomes = []
    for source, name, run in collectors:
        try:
            outcomes.append(run())
        except Exception as error:  # supplementary sources must never fail the town's job
            logger.exception("Wider source crashed source_id=%s", source)
            outcomes.append(
                (regions.result(source, name, "failed", f"{type(error).__name__}: {error}"), [])
            )
    return outcomes


def ingest(settings: Settings, job: dict, client: httpx.Client, today: date | None = None) -> None:
    started = time.monotonic()
    try:
        location = locations.get(settings.database, job["source_id"])
    except LookupError as error:
        raise ValueError(str(error)) from error
    today = today or date.today()
    start, end = window(today)
    systems, retained = [], []
    for system in location["systems"]:
        result, kept = collect(system, client, start, end)
        systems.append(result)
        retained += [(source_id(system), event, branch) for event, branch in kept]
    if location.get("government"):
        result, meetings = government_meetings.collect(location, client, today, (start, end))
        systems.append(result)
        retained += [(result["source_id"], meeting, None) for meeting in meetings]
    if settings.wider_sources:
        for result, facts in wider(location, client, today, settings.trending_cache_dir):
            systems.append(result)
            retained += [(result["source_id"], fact, None) for fact in facts]
    retrieved = datetime.now(UTC).isoformat()
    envelope = {
        "location_id": location["id"],
        "window": [start, end],
        "retrieved_at": retrieved,
        "systems": systems,
        "usage": "local_evaluation_only",
        "redistribution_permission": "unresolved",
        "events": [
            {"source_id": source, "branch": branch, **event.model_dump()}
            for source, event, branch in retained
        ],
    }
    evidence_dir = settings.evidence_dir / location["id"]
    evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = evidence_dir / f"{job['id']}-{uuid.uuid4()}.json"
    summary = {
        "location_id": location["id"],
        "event_count": len(retained),
        "skipped_other_venues": sum(system["skipped_other_venues"] for system in systems),
        "skipped_outside_window": sum(system["skipped_outside_window"] for system in systems),
        "duration_seconds": round(time.monotonic() - started, 3),
        "evidence_path": str(evidence.relative_to(settings.data_dir)),
        "systems": systems,
    }
    try:
        evidence.write_text(json.dumps(envelope, indent=2) + "\n", encoding="utf-8")
        with connect(settings.database) as database:
            database.execute("BEGIN IMMEDIATE")
            owned = database.execute(
                "SELECT id FROM jobs WHERE id = ? AND claim_token = ? AND status = 'running'",
                (job["id"], job["claim_token"]),
            ).fetchone()
            if owned is None:
                raise RuntimeError(f"Lost job lease: {job['id']}")
            for source, event, branch in retained:
                database.execute(
                    """INSERT INTO source_events VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(source_id, source_event_id, event_date) DO UPDATE SET
                        community_id = excluded.community_id,
                        facts_json = excluded.facts_json, retrieved_at = excluded.retrieved_at,
                        evidence_path = excluded.evidence_path""",
                    (
                        source,
                        event.source_event_id,
                        event.event_date,
                        location["id"],
                        json.dumps({**event.model_dump(), "branch": branch}),
                        retrieved,
                        summary["evidence_path"],
                    ),
                )
            summary["snapshot_id"] = snapshots.record(
                database,
                location["id"],
                job["id"],
                (start, end),
                [
                    {
                        "source_id": source,
                        "source_event_id": event.source_event_id,
                        "event_date": event.event_date,
                        "facts": {**event.model_dump(), "branch": branch},
                    }
                    for source, event, branch in retained
                ],
                systems,
                summary["evidence_path"],
            )
            summary["author_job_id"] = jobs.enqueue_within(
                database, location["id"], jobs.AUTHOR_KIND
            )
            database.execute(
                """UPDATE jobs SET status = 'completed', completed_at = ?, result_json = ?,
                    error = NULL, claim_token = NULL, lease_until = NULL
                    WHERE id = ? AND claim_token = ?""",
                (time.time(), json.dumps(summary), job["id"], job["claim_token"]),
            )
    except (OSError, RuntimeError, sqlite3.Error):
        evidence.unlink(missing_ok=True)
        raise
    logger.info(
        "Location ingestion completed job_id=%s location_id=%s events=%s "
        "skipped_other_venues=%s systems=%s snapshot_id=%s author_job_id=%s "
        "duration_seconds=%s",
        job["id"],
        location["id"],
        len(retained),
        summary["skipped_other_venues"],
        {system["source_id"]: system["status"] for system in systems},
        summary["snapshot_id"],
        summary["author_job_id"],
        summary["duration_seconds"],
    )
