import json
import logging
import sqlite3
import time
import uuid
from pathlib import Path

from projects.backend.shared.storage.database import connect
from shared.contracts.health import IngestionRun, SystemIngestion

logger = logging.getLogger(__name__)
JOB_KIND = "ingest_events"
AUTHOR_KIND = "author_edition"
KINDS = (JOB_KIND, AUTHOR_KIND)
MAX_ATTEMPTS = 3
LEASE_SECONDS = 90


def _run(row) -> IngestionRun:
    result = json.loads(row["result_json"]) if row["result_json"] else {}
    systems = result.get("systems")
    return IngestionRun(
        id=row["id"],
        location_id=row["source_id"],
        status=row["status"],
        attempts=row["attempts"],
        error=row["error"],
        systems=[
            SystemIngestion.model_validate(
                {key: system.get(key) for key in SystemIngestion.model_fields}
            )
            for system in systems
        ]
        if systems is not None
        else None,
        **{
            key: result.get(key)
            for key in (
                "event_count",
                "skipped_other_venues",
                "skipped_outside_window",
                "duration_seconds",
            )
        },
    )


def latest_run(path: Path, location_id: str | None = None) -> IngestionRun | None:
    with connect(path) as database:
        row = database.execute(
            "SELECT * FROM jobs WHERE kind = ? AND (? IS NULL OR source_id = ?) "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (JOB_KIND, location_id, location_id),
        ).fetchone()
    return _run(row) if row else None


def enqueue_within(database: sqlite3.Connection, location_id: str, kind: str = JOB_KIND) -> str:
    """Queue inside the caller's transaction. Ingestion dedupes on pending or running jobs;
    authoring dedupes on pending only, so a snapshot that lands mid-authoring still gets
    its own edition."""
    active = ("pending", "running") if kind == JOB_KIND else ("pending",)
    existing = database.execute(
        f"SELECT id FROM jobs WHERE kind = ? AND source_id = ? "
        f"AND status IN ({', '.join('?' for _ in active)})",
        (kind, location_id, *active),
    ).fetchone()
    if existing:
        return existing["id"]
    identity = str(uuid.uuid4())
    database.execute(
        "INSERT INTO jobs (id, kind, source_id, status, created_at) VALUES (?, ?, ?, ?, ?)",
        (identity, kind, location_id, "pending", time.time()),
    )
    logger.info("Job enqueued kind=%s job_id=%s location_id=%s", kind, identity, location_id)
    return identity


def enqueue(path: Path, location_id: str, kind: str = JOB_KIND) -> str:
    if kind not in KINDS:
        raise ValueError(f"Unknown job kind: {kind}")
    with connect(path) as database:
        database.execute("BEGIN IMMEDIATE")
        return enqueue_within(database, location_id, kind)


def claim(path: Path, kind: str | None = None) -> dict | None:
    """Claim the oldest available job, of any kind unless one is given."""
    now = time.time()
    with connect(path) as database:
        database.execute("BEGIN IMMEDIATE")
        expired = database.execute(
            "SELECT id, kind FROM jobs WHERE status = 'running' AND lease_until < ?", (now,)
        ).fetchall()
        for row in expired:
            logger.warning("Recovering expired lease kind=%s job_id=%s", row["kind"], row["id"])
        database.execute(
            """UPDATE jobs SET
                status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
                completed_at = CASE WHEN attempts >= ? THEN ? ELSE NULL END,
                error = 'Worker lease expired; previous attempt interrupted',
                lease_until = NULL, claim_token = NULL
                WHERE status = 'running' AND lease_until < ?""",
            (MAX_ATTEMPTS, MAX_ATTEMPTS, now, now),
        )
        row = database.execute(
            "SELECT * FROM jobs WHERE status = 'pending' AND available_at <= ? "
            "AND (? IS NULL OR kind = ?) ORDER BY created_at, id LIMIT 1",
            (now, kind, kind),
        ).fetchone()
        if row is None:
            return None
        token = str(uuid.uuid4())
        database.execute(
            """UPDATE jobs SET status = 'running', attempts = attempts + 1,
                started_at = ?, lease_until = ?, claim_token = ? WHERE id = ?""",
            (now, now + LEASE_SECONDS, token, row["id"]),
        )
        return dict(database.execute("SELECT * FROM jobs WHERE id = ?", (row["id"],)).fetchone())


def renew(path: Path, job: dict) -> None:
    with connect(path) as database:
        result = database.execute(
            "UPDATE jobs SET lease_until = ? "
            "WHERE id = ? AND claim_token = ? AND status = 'running'",
            (time.time() + LEASE_SECONDS, job["id"], job["claim_token"]),
        )
        if result.rowcount != 1:
            raise RuntimeError(f"Lost job lease: {job['id']}")


def complete(path: Path, job: dict, result: dict) -> None:
    with connect(path) as database:
        updated = database.execute(
            """UPDATE jobs SET status = 'completed', completed_at = ?, result_json = ?,
                error = NULL, claim_token = NULL, lease_until = NULL
                WHERE id = ? AND claim_token = ? AND status = 'running'""",
            (time.time(), json.dumps(result), job["id"], job["claim_token"]),
        )
        if updated.rowcount != 1:
            raise RuntimeError(f"Lost job lease: {job['id']}")


def fail(path: Path, job: dict, error: Exception, retryable: bool) -> None:
    retry = retryable and job["attempts"] < MAX_ATTEMPTS
    detail = f"{type(error).__name__}: {error}"
    with connect(path) as database:
        result = database.execute(
            """UPDATE jobs SET status = ?, error = ?, available_at = ?,
                completed_at = ?, lease_until = NULL, claim_token = NULL
                WHERE id = ? AND claim_token = ? AND status = 'running'""",
            (
                "pending" if retry else "failed",
                detail,
                time.time() + 2 ** job["attempts"],
                None if retry else time.time(),
                job["id"],
                job["claim_token"],
            ),
        )
        if result.rowcount != 1:
            raise RuntimeError(f"Cannot record failure after lost lease: {job['id']}")
    logger.error(
        "Job %s kind=%s job_id=%s error=%s",
        "retry scheduled" if retry else "failed",
        job["kind"],
        job["id"],
        detail,
    )


def inspect(path: Path) -> dict:
    with connect(path) as database:
        jobs = [
            dict(row)
            for row in database.execute(
                "SELECT id, source_id AS location_id, status, attempts, created_at, started_at, "
                "completed_at, error, result_json FROM jobs WHERE kind = ? "
                "ORDER BY created_at DESC LIMIT 20",
                (JOB_KIND,),
            )
        ]
        for job in jobs:
            result = job.pop("result_json")
            job["result"] = json.loads(result) if result else None
        events = []
        for row in database.execute(
            "SELECT * FROM source_events ORDER BY event_date, source_event_id LIMIT 200"
        ):
            event = dict(row)
            event["facts"] = json.loads(event.pop("facts_json"))
            events.append(event)
    return {
        "jobs": jobs,
        "events": events,
        "usage": "local_evaluation_only",
        "redistribution_permission": "unresolved",
    }
