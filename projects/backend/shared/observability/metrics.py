"""Read-only operational metrics aggregated from the local SQLite history."""

import json
import math
import statistics
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

from projects.backend.modules.communities import locations
from projects.backend.modules.orchestration.jobs import JOB_KIND
from projects.backend.shared.storage.database import connect
from shared.contracts.metrics import (
    DailyRuns,
    EditionMetrics,
    EmailMetrics,
    IngestionMetrics,
    LocationFreshness,
    MetricsReport,
    QueueMetrics,
    SourceKindMetrics,
)

DAY = 86400


def _day(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, UTC).date().isoformat()


def _days(now: float, window_days: int) -> dict[str, DailyRuns]:
    return {
        day: DailyRuns(day=day)
        for day in (_day(now - offset * DAY) for offset in range(window_days - 1, -1, -1))
    }


def _rate(part: int, whole: int) -> float | None:
    return round(part / whole, 4) if whole else None


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[max(0, math.ceil(fraction * len(ordered)) - 1)], 3)


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 3) if values else None


def _result(row) -> dict:
    return json.loads(row["result_json"]) if row["result_json"] else {}


def _source_kind(source_id: str | None) -> str:
    return "government" if (source_id or "").startswith("meetings:") else "library"


def _ingestion(database, since: float, now: float, window_days: int) -> IngestionMetrics:
    metrics = IngestionMetrics()
    daily = _days(now, window_days)
    durations = []
    for row in database.execute(
        "SELECT status, attempts, completed_at, result_json FROM jobs WHERE kind = ? "
        "AND status IN ('completed', 'failed') AND completed_at >= ?",
        (JOB_KIND, since),
    ):
        metrics.runs += 1
        metrics.retried += row["attempts"] > 1
        bucket = daily.get(_day(row["completed_at"]))
        if row["status"] == "failed":
            metrics.failed += 1
            if bucket:
                bucket.failed += 1
            continue
        metrics.completed += 1
        result = _result(row)
        events = result.get("event_count") or 0
        metrics.events += events
        metrics.skipped_other_venues += result.get("skipped_other_venues") or 0
        metrics.skipped_outside_window += result.get("skipped_outside_window") or 0
        if result.get("duration_seconds") is not None:
            durations.append(result["duration_seconds"])
        if bucket:
            bucket.completed += 1
            bucket.items += events
    metrics.success_rate = _rate(metrics.completed, metrics.runs)
    metrics.median_duration_seconds = _median(durations)
    metrics.p95_duration_seconds = _percentile(durations, 0.95)
    metrics.daily = list(daily.values())
    return metrics


def _editions(database, since: float, now: float, window_days: int) -> EditionMetrics:
    metrics = EditionMetrics()
    daily = _days(now, window_days)
    durations = []
    for row in database.execute(
        "SELECT status, completed_at, result_json FROM edition_drafts "
        "WHERE status IN ('completed', 'failed') AND completed_at >= ?",
        (since,),
    ):
        metrics.runs += 1
        bucket = daily.get(_day(row["completed_at"]))
        if row["status"] == "failed":
            metrics.failed += 1
            if bucket:
                bucket.failed += 1
            continue
        metrics.completed += 1
        result = _result(row)
        included = result.get("included") or 0
        metrics.included += included
        metrics.held += result.get("held") or 0
        metrics.ranked += result.get("ranked") or 0
        metrics.ranking_fallback_ratings += (result.get("ranking") or {}).get(
            "fallback_ratings"
        ) or 0
        metrics.headline_fallbacks += bool((result.get("front") or {}).get("fallback"))
        if result.get("duration_seconds") is not None:
            durations.append(result["duration_seconds"])
        if bucket:
            bucket.completed += 1
            bucket.items += included
    metrics.publish_rate = _rate(metrics.completed, metrics.runs)
    metrics.held_rate = _rate(metrics.held, metrics.included + metrics.held)
    metrics.ranking_fallback_rate = _rate(metrics.ranking_fallback_ratings, metrics.ranked)
    metrics.median_duration_seconds = _median(durations)
    metrics.daily = list(daily.values())
    return metrics


def _email(database, since: float) -> EmailMetrics:
    metrics = EmailMetrics()
    for row in database.execute(
        "SELECT status, COUNT(*) AS count FROM email_deliveries "
        "WHERE status != 'superseded' AND updated_at >= ? GROUP BY status",
        (since,),
    ):
        setattr(metrics, row["status"], row["count"])
    metrics.delivery_rate = _rate(metrics.sent, metrics.sent + metrics.failed)
    return metrics


def _queue(database, now: float) -> QueueMetrics:
    metrics = QueueMetrics()
    by_kind: dict[str, dict[str, int]] = defaultdict(
        lambda: {"pending": 0, "running": 0, "failed_last_24h": 0}
    )
    for row in database.execute(
        "SELECT kind, status, COUNT(*) AS count FROM jobs "
        "WHERE status IN ('pending', 'running') GROUP BY kind, status"
    ):
        by_kind[row["kind"]][row["status"]] = row["count"]
        setattr(metrics, row["status"], getattr(metrics, row["status"]) + row["count"])
    for row in database.execute(
        "SELECT kind, COUNT(*) AS count FROM jobs WHERE status = 'failed' "
        "AND completed_at >= ? GROUP BY kind",
        (now - DAY,),
    ):
        by_kind[row["kind"]]["failed_last_24h"] = row["count"]
        metrics.failed_last_24h += row["count"]
    metrics.by_kind = dict(sorted(by_kind.items()))
    oldest = database.execute("SELECT MIN(created_at) FROM jobs WHERE status = 'pending'")
    oldest = oldest.fetchone()[0]
    metrics.oldest_pending_age_seconds = round(now - oldest, 1) if oldest is not None else None
    beat = database.execute("SELECT updated_at FROM worker_heartbeat WHERE id = 1").fetchone()
    metrics.worker_heartbeat_age_seconds = round(now - beat[0], 1) if beat else None
    return metrics


def _locations(
    database, onboarded: list[dict], now: float
) -> tuple[list[LocationFreshness], list[SourceKindMetrics]]:
    kinds = {kind: SourceKindMetrics(kind=kind) for kind in ("library", "government")}
    result = []
    for location in onboarded:
        latest = database.execute(
            "SELECT status FROM jobs WHERE kind = ? AND source_id = ? "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (JOB_KIND, location["id"]),
        ).fetchone()
        ingested = database.execute(
            "SELECT completed_at, result_json FROM jobs WHERE kind = ? AND source_id = ? "
            "AND status = 'completed' ORDER BY completed_at DESC, id DESC LIMIT 1",
            (JOB_KIND, location["id"]),
        ).fetchone()
        published = database.execute(
            "SELECT MAX(completed_at) FROM edition_drafts "
            "WHERE community_id = ? AND status = 'completed'",
            (location["id"],),
        ).fetchone()[0]
        systems = (_result(ingested).get("systems") or []) if ingested else []
        for system in systems:
            kind = kinds[_source_kind(system.get("source_id"))]
            kind.sources += 1
            kind.ingested += system.get("status") == "ingested"
            kind.events += system.get("event_count") or 0
        result.append(
            LocationFreshness(
                id=location["id"],
                name=location["name"],
                ingestion_status=latest["status"] if latest else None,
                last_ingested_age_seconds=round(now - ingested["completed_at"], 1)
                if ingested
                else None,
                last_published_age_seconds=round(now - published, 1)
                if published is not None
                else None,
                events=_result(ingested).get("event_count") if ingested else None,
                sources=len(systems),
                sources_ingested=sum(system.get("status") == "ingested" for system in systems),
                government_platform=(location.get("government") or {}).get("platform"),
            )
        )
    return result, list(kinds.values())


def collect_metrics(path: Path, window_days: int = 7, now: float | None = None) -> MetricsReport:
    if not path.is_file():
        raise FileNotFoundError(f"Database not initialized: {path}")
    now = time.time() if now is None else now
    since = now - window_days * DAY
    onboarded = locations.list_all(path)
    with connect(path) as database:
        ingestion = _ingestion(database, since, now, window_days)
        freshness, by_source = _locations(database, onboarded, now)
        ingestion.by_source = by_source
        return MetricsReport(
            generated_at=now,
            window_days=window_days,
            ingestion=ingestion,
            editions=_editions(database, since, now, window_days),
            email=_email(database, since),
            queue=_queue(database, now),
            locations=freshness,
        )
