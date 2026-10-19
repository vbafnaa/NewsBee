import json
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from projects.backend.modules.orchestration import jobs, worker
from projects.backend.modules.source_connectors.pipelines.events import ingest
from projects.backend.shared.configuration.settings import ROOT
from projects.backend.shared.storage.database import connect, initialize


@pytest.fixture
def feed():
    return (ROOT / "tests" / "fixtures" / "library_events.xml").read_bytes()


def execute_fixture(settings, job, feed):
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=feed))
    ) as client:
        ingest(settings, job, client)


def test_queue_pipeline_storage_and_replay_are_idempotent(settings, feed):
    initialize(settings.database)
    for _ in range(2):
        identity = jobs.enqueue(settings.database, "spl-capitol-hill")
        assert jobs.enqueue(settings.database, "spl-capitol-hill") == identity
        job = jobs.claim(settings.database)
        execute_fixture(settings, job, feed)
    report = jobs.inspect(settings.database)
    assert len(report["events"]) == 1
    assert len(report["jobs"]) == 2
    assert all(job["status"] == "completed" for job in report["jobs"])
    for file in settings.evidence_dir.rglob("*.json"):
        content = file.read_text()
        assert "PRIVATE_DESCRIPTION" not in content
        assert "do-not-save" not in content
        envelope = json.loads(content)
        assert envelope["redistribution_permission"] == "unresolved"
        assert len(envelope["response_sha256"]) == 64
    assert report["jobs"][0]["result"]["skipped_other_venues"] == 1


def test_lease_expiry_reclaims_and_fences_old_attempt(settings, feed):
    initialize(settings.database)
    jobs.enqueue(settings.database, "spl-capitol-hill")
    first = jobs.claim(settings.database)
    with connect(settings.database) as database:
        database.execute("UPDATE jobs SET lease_until = 0 WHERE id = ?", (first["id"],))
    replacement = jobs.claim(settings.database)
    assert replacement["attempts"] == 2
    with pytest.raises(RuntimeError, match="Lost job lease"):
        execute_fixture(settings, first, feed)
    assert list(settings.evidence_dir.rglob("*.json")) == []
    execute_fixture(settings, replacement, feed)
    assert jobs.inspect(settings.database)["jobs"][0]["status"] == "completed"


def test_retry_exhaustion_and_failure_are_recorded(settings):
    initialize(settings.database)
    jobs.enqueue(settings.database, "spl-capitol-hill")
    for attempt in range(1, 4):
        job = jobs.claim(settings.database)
        assert job["attempts"] == attempt
        jobs.fail(settings.database, job, httpx.ConnectError("fixture outage"), retryable=True)
        if attempt < 3:
            assert jobs.claim(settings.database) is None
            with connect(settings.database) as database:
                database.execute("UPDATE jobs SET available_at = 0")
    result = jobs.inspect(settings.database)["jobs"][0]
    assert result["status"] == "failed"
    assert "fixture outage" in result["error"]
    assert jobs.claim(settings.database) is None


def test_worker_executes_jobs_while_recording_heartbeat(settings, feed, monkeypatch):
    initialize(settings.database)
    identity = jobs.enqueue(settings.database, "spl-capitol-hill")
    monkeypatch.setattr(
        worker, "execute", lambda settings, job: execute_fixture(settings, job, feed)
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
    jobs.enqueue(settings.database, "spl-capitol-hill")
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: jobs.claim(settings.database), range(2)))
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
        assert database.execute("PRAGMA user_version").fetchone()[0] == 4


def test_worker_records_invalid_feed_without_retry(settings, monkeypatch):
    from projects.backend.modules.source_connectors.connectors.spl_rss import FeedFormatError

    initialize(settings.database)
    jobs.enqueue(settings.database, "spl-capitol-hill")

    def malformed(*_):
        raise FeedFormatError("fixture malformed feed")

    monkeypatch.setattr(worker, "ingest", malformed)
    worker.execute(settings, jobs.claim(settings.database))
    report = jobs.inspect(settings.database)
    assert report["jobs"][0]["status"] == "failed"
    assert report["jobs"][0]["attempts"] == 1
    assert "fixture malformed feed" in report["jobs"][0]["error"]
    assert report["events"] == []


def test_repeated_worker_crashes_exhaust_recovery_attempts(settings):
    initialize(settings.database)
    jobs.enqueue(settings.database, "spl-capitol-hill")
    for attempt in range(1, 4):
        claimed = jobs.claim(settings.database)
        assert claimed["attempts"] == attempt
        with connect(settings.database) as database:
            database.execute("UPDATE jobs SET lease_until = 0")
    assert jobs.claim(settings.database) is None
    result = jobs.inspect(settings.database)["jobs"][0]
    assert result["status"] == "failed"
    assert result["completed_at"] is not None


def test_failed_feed_retains_no_partial_event_records(settings, feed):
    initialize(settings.database)
    jobs.enqueue(settings.database, "spl-capitol-hill")
    job = jobs.claim(settings.database)
    invalid = feed.replace(b"Location Link", b"Unknown Location")
    with pytest.raises(ValueError, match="venue attribution"):
        execute_fixture(settings, job, invalid)
    assert jobs.inspect(settings.database)["events"] == []
    assert not settings.evidence_dir.exists()
