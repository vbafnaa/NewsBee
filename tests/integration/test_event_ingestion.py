import json
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import httpx
import pytest

from projects.backend.modules.communities import locations
from projects.backend.modules.orchestration import jobs, orchestrator, worker
from projects.backend.modules.source_connectors.connectors import bibliocommons
from projects.backend.modules.source_connectors.connectors.common import FeedFormatError
from projects.backend.shared.storage.database import SCHEMA_VERSION, connect, initialize
from tests import library_world
from tests.library_world import CALENDAR, FEED_URL, HOMEPAGE, LOCATION_ID


@pytest.fixture
def onboarded(settings):
    initialize(settings.database)
    return library_world.onboard(settings.database)


def run_once(settings, table=None, today=library_world.TODAY) -> dict:
    jobs.enqueue(settings.database, LOCATION_ID)
    library_world.ingest(settings, jobs.claim(settings.database, jobs.JOB_KIND), table, today)
    return jobs.inspect(settings.database)


def systems(report) -> dict:
    return {system["source_id"]: system for system in report["jobs"][0]["result"]["systems"]}


def test_location_ingest_discovers_feed_and_keeps_in_town_events(settings, onboarded):
    seen = []
    jobs.enqueue(settings.database, LOCATION_ID)
    with httpx.Client(transport=library_world.transport(seen=seen)) as client:
        from projects.backend.modules.source_connectors.pipelines.events import ingest

        ingest(
            settings,
            jobs.claim(settings.database, jobs.JOB_KIND),
            client,
            today=library_world.TODAY,
        )
    report = jobs.inspect(settings.database)
    [event] = report["events"]
    assert (event["source_id"], event["community_id"]) == ("library:WA0001", LOCATION_ID)
    assert event["facts"]["venue"] == "Capitol Hill Branch"
    assert event["facts"]["branch"] == "Capitol Hill"
    result = report["jobs"][0]["result"]
    assert result["location_id"] == LOCATION_ID
    assert (result["event_count"], result["skipped_other_venues"]) == (1, 1)
    city, county = systems(report)["library:WA0001"], systems(report)["library:WA0002"]
    assert (city["status"], city["feed_kind"], city["feed_url"]) == (
        "ingested",
        "trumba_rss",
        FEED_URL,
    )
    assert city["pages_checked"] == [HOMEPAGE, CALENDAR]
    assert city["unmatched_venues"] == {"Central Library": 1}
    assert len(city["response_sha256"]) == 64
    assert county["status"] == "unresolved_website" and county["event_count"] == 0
    assert "https://www.spl.org/about" not in seen
    assert "https://www.spl.org/robots.txt" in seen


def test_replay_is_idempotent_and_evidence_is_minimal(settings, onboarded):
    for _ in range(2):
        identity = jobs.enqueue(settings.database, LOCATION_ID)
        assert jobs.enqueue(settings.database, LOCATION_ID) == identity
        library_world.ingest(settings, jobs.claim(settings.database, jobs.JOB_KIND))
    report = jobs.inspect(settings.database)
    assert len(report["events"]) == 1
    assert [job["status"] for job in report["jobs"]] == ["completed", "completed"]
    files = list((settings.evidence_dir / LOCATION_ID).glob("*.json"))
    assert len(files) == 2
    for file in files:
        content = file.read_text()
        assert "do-not-save" not in content and "Stories & songs for toddlers." in content
        envelope = json.loads(content)
        assert envelope["redistribution_permission"] == "unresolved"
        assert envelope["window"] == ["2026-11-01", "2026-11-07"]


def test_only_next_seven_days_from_tomorrow_are_kept(settings, onboarded):
    report = run_once(settings, today=date(2026, 11, 3))
    assert report["events"] == [], "events on the ingestion day are excluded"
    result = report["jobs"][0]["result"]
    assert (result["skipped_outside_window"], result["skipped_other_venues"]) == (1, 1)
    assert run_once(settings, today=date(2026, 10, 25))["events"] == []
    assert len(run_once(settings, today=date(2026, 11, 2))["events"]) == 1


def test_one_system_failing_does_not_fail_the_location(settings, onboarded):
    table = library_world.routes(library_world.feed().replace(b"Location Link", b"Unknown"))
    report = run_once(settings, table)
    assert report["jobs"][0]["status"] == "completed"
    city = systems(report)["library:WA0001"]
    assert city["status"] == "failed" and "venue attribution" in city["detail"]
    assert report["events"] == []


@pytest.mark.parametrize(
    ("change", "status", "detail"),
    [
        (
            {
                "https://www.spl.org/robots.txt": httpx.Response(
                    200, text="User-agent: *\nDisallow: /"
                )
            },
            "blocked",
            "robots.txt disallows",
        ),
        (
            {HOMEPAGE: httpx.Response(200, content=b"<p>No calendar here</p>")},
            "no_feed",
            "No supported event feed",
        ),
        (
            {HOMEPAGE: httpx.Response(301, headers={"location": "http://www.spl.org/"})},
            "failed",
            "non-HTTPS",
        ),
        ({FEED_URL: httpx.Response(404)}, "failed", "404"),
    ],
    ids=["robots", "no-feed", "https-downgrade", "feed-404"],
)
def test_discovery_outcomes_are_reported_per_system(settings, onboarded, change, status, detail):
    report = run_once(settings, {**library_world.routes(), **change})
    city = systems(report)["library:WA0001"]
    assert city["status"] == status and detail in city["detail"]
    assert report["jobs"][0]["status"] == "completed"


@pytest.mark.parametrize("status", [429, 503])
def test_transient_http_errors_retry_and_store_nothing(settings, onboarded, status):
    jobs.enqueue(settings.database, LOCATION_ID)
    job = jobs.claim(settings.database, jobs.JOB_KIND)
    with pytest.raises(httpx.HTTPStatusError):
        library_world.ingest(
            settings, job, {**library_world.routes(), FEED_URL: httpx.Response(status)}
        )
    assert jobs.inspect(settings.database)["events"] == []
    assert not settings.evidence_dir.exists()


def test_orchestrator_queues_every_location_and_reports_status(settings, onboarded):
    second = {**library_world.profile(), "id": "tacoma-wa", "name": "Tacoma, WA"}
    from projects.backend.modules.communities import locations

    locations.save(settings.database, second)
    queued = orchestrator.enqueue_all(settings.database)
    assert set(queued) == {LOCATION_ID, "tacoma-wa"}
    library_world.ingest(settings, jobs.claim(settings.database, jobs.JOB_KIND))
    statuses = {status.id: status for status in orchestrator.statuses(settings.database)}
    assert statuses[LOCATION_ID].websites_resolved == 1
    assert statuses[LOCATION_ID].library_systems == 2
    done = [status for status in statuses.values() if status.latest_ingestion.status == "completed"]
    assert len(done) == 1 and done[0].latest_ingestion.systems[0].status == "ingested"


def test_unknown_location_fails_without_retry(settings):
    initialize(settings.database)
    jobs.enqueue(settings.database, "nowhere-xx")
    worker.execute(settings, jobs.claim(settings.database, jobs.JOB_KIND))
    job = jobs.inspect(settings.database)["jobs"][0]
    assert (job["status"], job["attempts"]) == ("failed", 1)
    assert "not onboarded" in job["error"]


def test_lease_expiry_reclaims_and_fences_old_attempt(settings, onboarded):
    jobs.enqueue(settings.database, LOCATION_ID)
    first = jobs.claim(settings.database, jobs.JOB_KIND)
    with connect(settings.database) as database:
        database.execute("UPDATE jobs SET lease_until = 0 WHERE id = ?", (first["id"],))
    replacement = jobs.claim(settings.database, jobs.JOB_KIND)
    assert replacement["attempts"] == 2
    with pytest.raises(RuntimeError, match="Lost job lease"):
        library_world.ingest(settings, first)
    assert list(settings.evidence_dir.rglob("*.json")) == []
    library_world.ingest(settings, replacement)
    assert jobs.inspect(settings.database)["jobs"][0]["status"] == "completed"


def test_worker_survives_job_finishing_just_before_lease_renewal(settings, monkeypatch):
    initialize(settings.database)
    jobs.enqueue(settings.database, LOCATION_ID)
    stop, release = threading.Event(), threading.Event()
    real_renew = jobs.renew

    def finish_then_block(settings, job):
        jobs.complete(settings.database, job, {"done": True})
        release.wait(5)

    def renew_after_completion(path, job):
        renewed = real_renew(path, job)
        stop.set()
        release.set()
        return renewed

    monkeypatch.setattr(worker, "execute", finish_then_block)
    monkeypatch.setattr(jobs, "renew", renew_after_completion)
    worker.run(settings.model_copy(update={"heartbeat_interval": 0.1}), stop)
    assert jobs.inspect(settings.database)["jobs"][0]["status"] == "completed"


def test_retry_exhaustion_and_failure_are_recorded(settings):
    initialize(settings.database)
    jobs.enqueue(settings.database, LOCATION_ID)
    for attempt in range(1, 4):
        job = jobs.claim(settings.database, jobs.JOB_KIND)
        assert job["attempts"] == attempt
        jobs.fail(settings.database, job, httpx.ConnectError("fixture outage"), retryable=True)
        if attempt < 3:
            assert jobs.claim(settings.database, jobs.JOB_KIND) is None
            with connect(settings.database) as database:
                database.execute("UPDATE jobs SET available_at = 0")
    result = jobs.inspect(settings.database)["jobs"][0]
    assert result["status"] == "failed"
    assert "fixture outage" in result["error"]
    assert jobs.claim(settings.database, jobs.JOB_KIND) is None


def test_worker_executes_jobs_while_recording_heartbeat(settings, onboarded, monkeypatch):
    identity = jobs.enqueue(settings.database, LOCATION_ID)
    monkeypatch.setattr(
        worker, "execute", lambda settings, job: library_world.ingest(settings, job)
    )
    stop = threading.Event()
    thread = threading.Thread(target=worker.run, args=(settings, stop))
    thread.start()
    try:
        deadline = time.monotonic() + 8
        while jobs.inspect(settings.database)["jobs"][0]["status"] != "completed":
            if time.monotonic() > deadline:
                pytest.fail(f"Worker did not finish fixture job {identity}")
            time.sleep(0.05)
    finally:
        stop.set()
        thread.join(timeout=5)
    assert not thread.is_alive()


def test_only_one_worker_claims_a_job(settings):
    initialize(settings.database)
    jobs.enqueue(settings.database, LOCATION_ID)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: jobs.claim(settings.database, jobs.JOB_KIND), range(2)))
    assert sum(job is not None for job in claims) == 1


def test_schema_one_upgrades_without_losing_existing_jobs(settings):
    settings.database.parent.mkdir(parents=True)
    with sqlite3.connect(settings.database) as database:
        database.execute(
            "CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT, status TEXT, created_at REAL, "
            "completed_at REAL, error TEXT)"
        )
        database.execute("INSERT INTO jobs VALUES ('old', 'fixture', 'pending', 1, NULL, NULL)")
        database.execute("PRAGMA user_version = 1")
    initialize(settings.database)
    with connect(settings.database) as database:
        assert database.execute("SELECT id FROM jobs").fetchone()[0] == "old"
        assert database.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 7


def test_v4_single_source_data_is_dropped_on_upgrade(settings, ingested_event):
    with connect(settings.database) as database:
        database.execute("DROP TABLE locations")
        database.execute("PRAGMA user_version = 4")
    initialize(settings.database)
    report = jobs.inspect(settings.database)
    assert report["events"] == [] and report["jobs"] == []
    with connect(settings.database) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == 7
        assert database.execute("SELECT COUNT(*) FROM locations").fetchone()[0] == 0


def test_worker_records_invalid_feed_without_retry(settings, monkeypatch):
    initialize(settings.database)
    jobs.enqueue(settings.database, LOCATION_ID)

    def malformed(*_):
        raise FeedFormatError("fixture malformed feed")

    monkeypatch.setattr(worker, "ingest", malformed)
    worker.execute(settings, jobs.claim(settings.database, jobs.JOB_KIND))
    report = jobs.inspect(settings.database)
    assert report["jobs"][0]["status"] == "failed"
    assert report["jobs"][0]["attempts"] == 1
    assert "fixture malformed feed" in report["jobs"][0]["error"]
    assert report["events"] == []


def test_repeated_worker_crashes_exhaust_recovery_attempts(settings):
    initialize(settings.database)
    jobs.enqueue(settings.database, LOCATION_ID)
    for attempt in range(1, 4):
        claimed = jobs.claim(settings.database, jobs.JOB_KIND)
        assert claimed["attempts"] == attempt
        with connect(settings.database) as database:
            database.execute("UPDATE jobs SET lease_until = 0")
    assert jobs.claim(settings.database, jobs.JOB_KIND) is None
    result = jobs.inspect(settings.database)["jobs"][0]
    assert result["status"] == "failed"
    assert result["completed_at"] is not None


def test_bibliocommons_system_is_ingested_at_in_town_branches(settings, onboarded, monkeypatch):
    monkeypatch.setattr(bibliocommons, "REQUEST_INTERVAL_SECONDS", 0)
    location = library_world.profile()
    location["systems"][1]["website"] = library_world.COUNTY_HOME
    locations.save(settings.database, location)
    report = run_once(settings, {**library_world.routes(), **library_world.biblio_routes()})
    county = systems(report)["library:WA0002"]
    assert (county["status"], county["feed_kind"], county["event_count"]) == (
        "ingested",
        "bibliocommons",
        1,
    )
    assert county["detail"] == "bibliocommons feed (1 of 2 locations in town)"
    assert county["skipped_unusable"] == {"cancelled": 1}
    [event] = [event for event in report["events"] if event["source_id"] == "library:WA0002"]
    assert event["facts"]["branch"] == "Lake Example"
    assert event["facts"]["title"] == "Lego Club"
    assert event["facts"]["source_url"] == "https://exco.bibliocommons.com/events/ev1"
    assert report["jobs"][0]["result"]["event_count"] == 2


def onboard_with_meetings(settings) -> None:
    from tests import meetings_world

    initialize(settings.database)
    profile = {**library_world.profile(), "government": meetings_world.government()}
    locations.save(settings.database, profile)


def test_public_meetings_join_the_location_snapshot(settings):
    from projects.backend.shared.storage import snapshots
    from tests import meetings_world

    onboard_with_meetings(settings)
    report = run_once(settings, {**library_world.routes(), **meetings_world.legistar_routes()})
    meeting = systems(report)["meetings:legistar:exampletown"]
    assert (meeting["status"], meeting["event_count"], meeting["feed_kind"]) == (
        "ingested",
        2,
        "legistar",
    )
    assert systems(report)["library:WA0001"]["event_count"] == 1
    stored = {(e["source_id"], e["facts"].get("kind", "event")) for e in report["events"]}
    assert stored == {
        ("library:WA0001", "event"),
        ("meetings:legistar:exampletown", "meeting_preview"),
        ("meetings:legistar:exampletown", "meeting_outcome"),
    }
    snapshot = snapshots.latest(settings.database, LOCATION_ID)
    assert (snapshot["window_start"], snapshot["window_end"]) == ("2026-11-01", "2026-11-07")
    kinds = sorted(
        e["facts"].get("kind", "event") for e in snapshots.events(settings.database, snapshot["id"])
    )
    assert kinds == ["event", "meeting_outcome", "meeting_preview"]


def test_meeting_rate_limits_retry_and_store_nothing(settings):
    from projects.backend.modules.source_connectors.connectors import legistar
    from tests import meetings_world

    onboard_with_meetings(settings)
    table = {**library_world.routes(), **meetings_world.legistar_routes()}
    table[meetings_world.key(legistar.items_url(meetings_world.LEGISTAR, 3))] = httpx.Response(429)
    jobs.enqueue(settings.database, LOCATION_ID)
    job = jobs.claim(settings.database, jobs.JOB_KIND)
    with pytest.raises(httpx.HTTPStatusError):
        library_world.ingest(settings, job, table)
    assert jobs.inspect(settings.database)["events"] == []
