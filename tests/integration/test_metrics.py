import json

from projects.backend.shared.observability.metrics import collect_metrics
from projects.backend.shared.storage.database import connect, initialize
from tests import library_world

NOW = 1_800_000_000.0
DAY = 86400


def job(database, identity, status, completed_at, result=None, attempts=1, kind="ingest_events"):
    database.execute(
        "INSERT INTO jobs (id, kind, source_id, status, created_at, completed_at, attempts, "
        "result_json) VALUES (?, ?, 'seattle-wa', ?, ?, ?, ?, ?)",
        (
            identity,
            kind,
            status,
            (completed_at or NOW) - 5,
            completed_at,
            attempts,
            json.dumps(result) if result else None,
        ),
    )


def draft(database, identity, status, completed_at, result=None):
    database.execute(
        "INSERT INTO edition_drafts (id, community_id, window_start, window_end, model, "
        "validation_policy, status, created_at, completed_at, result_json) "
        "VALUES (?, 'seattle-wa', '2027-01-01', '2027-01-07', 'm', 'p', ?, ?, ?, ?)",
        (identity, status, completed_at - 5, completed_at, json.dumps(result) if result else None),
    )


def test_metrics_aggregate_window_rates_sources_and_freshness(settings):
    initialize(settings.database)
    library_world.onboard(settings.database)
    systems = [
        {"source_id": "library:spl", "status": "ingested", "event_count": 8},
        {"source_id": "library:kcls", "status": "unresolved_website", "event_count": 0},
        {"source_id": "meetings:legistar:seattle", "status": "ingested", "event_count": 4},
    ]
    with connect(settings.database) as database:
        job(database, "too-old", "failed", NOW - 10 * DAY)
        job(database, "fail", "failed", NOW - 2 * DAY, attempts=3)
        job(
            database,
            "ok-1",
            "completed",
            NOW - DAY,
            {"event_count": 10, "skipped_outside_window": 2, "duration_seconds": 1.0},
        )
        job(
            database,
            "ok-2",
            "completed",
            NOW - 60,
            {"event_count": 12, "duration_seconds": 3.0, "systems": systems},
            attempts=2,
        )
        job(database, "queued", "pending", None)
        job(database, "author-fail", "failed", NOW - 3600, kind="author_edition")
        draft(
            database,
            "e-1",
            "completed",
            NOW - 30,
            {
                "included": 6,
                "held": 2,
                "ranked": 10,
                "ranking": {"fallback_ratings": 1},
                "front": {"fallback": True},
                "duration_seconds": 20.0,
            },
        )
        draft(database, "e-2", "failed", NOW - DAY)
        draft(database, "e-1-old", "completed", NOW - 9 * DAY, {"included": 99})
        for address, status in (("a@x", "sent"), ("b@x", "sent"), ("c@x", "failed")):
            database.execute(
                "INSERT INTO email_deliveries (edition_id, address, status, updated_at) "
                "VALUES ('e-1', ?, ?, ?)",
                (address, status, NOW - 10),
            )
        database.execute("INSERT INTO worker_heartbeat (id, updated_at) VALUES (1, ?)", (NOW - 4,))

    report = collect_metrics(settings.database, now=NOW)

    ingestion = report.ingestion
    assert (ingestion.runs, ingestion.completed, ingestion.failed) == (3, 2, 1)
    assert ingestion.success_rate == 0.6667
    assert ingestion.retried == 2
    assert ingestion.events == 22 and ingestion.skipped_outside_window == 2
    assert ingestion.median_duration_seconds == 2.0 and ingestion.p95_duration_seconds == 3.0
    assert [day.day for day in ingestion.daily][-1] == "2027-01-15"
    assert ingestion.daily[-1].completed == 1 and ingestion.daily[-1].items == 12
    by_source = {kind.kind: kind for kind in ingestion.by_source}
    assert (by_source["library"].sources, by_source["library"].ingested) == (2, 1)
    assert (by_source["government"].sources, by_source["government"].events) == (1, 4)

    editions = report.editions
    assert (editions.runs, editions.completed, editions.failed) == (2, 1, 1)
    assert editions.publish_rate == 0.5 and editions.held_rate == 0.25
    assert editions.ranking_fallback_rate == 0.1 and editions.headline_fallbacks == 1

    assert (report.email.sent, report.email.failed, report.email.delivery_rate) == (2, 1, 0.6667)

    queue = report.queue
    assert queue.pending == 1 and queue.failed_last_24h == 1
    assert queue.by_kind["author_edition"]["failed_last_24h"] == 1
    assert queue.worker_heartbeat_age_seconds == 4.0

    [location] = report.locations
    assert location.ingestion_status == "pending"
    assert location.last_ingested_age_seconds == 60.0
    assert location.last_published_age_seconds == 30.0
    assert (location.events, location.sources, location.sources_ingested) == (12, 3, 2)
