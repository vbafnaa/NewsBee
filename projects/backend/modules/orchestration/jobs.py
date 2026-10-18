import json
import logging
import time
import uuid
from pathlib import Path

from projects.backend.shared.storage.database import connect
from shared.contracts.health import IngestionRun

logger = logging.getLogger(__name__)
JOB_KIND = "ingest_events"
MAX_ATTEMPTS = 3
LEASE_SECONDS = 90


def latest_run(path: Path) -> IngestionRun | None:
    with connect(path) as database:
        row = database.execute(
            "SELECT * FROM jobs WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT 1",
            (JOB_KIND,),
        ).fetchone()
        if row is None:
            return None
        result = json.loads(row["result_json"]) if row["result_json"] else {}
        return IngestionRun(
            id=row["id"],
            source_id=row["source_id"],
            status=row["status"],
            attempts=row["attempts"],
            error=row["error"],
            **{
                key: result.get(key)
                for key in (
                    "event_count",
                    "skipped_other_venues",
                    "skipped_library_closures",
                    "duration_seconds",
                )
            },
        )


def enqueue(path: Path, source_id: str) -> str:
    identity = str(uuid.uuid4())
    with connect(path) as database:
        database.execute("BEGIN IMMEDIATE")
        existing = database.execute(
            "SELECT id FROM jobs WHERE kind = ? AND source_id = ? "
            "AND status IN ('pending', 'running')",
            (JOB_KIND, source_id),
        ).fetchone()
        if existing:
            return existing["id"]
        database.execute(
            "INSERT INTO jobs (id, kind, source_id, status, created_at) VALUES (?, ?, ?, ?, ?)",
            (identity, JOB_KIND, source_id, "pending", time.time()),
        )
    logger.info("Source job enqueued job_id=%s source_id=%s", identity, source_id)
    return identity


def claim(path: Path) -> dict | None:
    now = time.time()
    with connect(path) as database:
        database.execute("BEGIN IMMEDIATE")
        expired = database.execute(
            "SELECT id FROM jobs WHERE kind = ? AND status = 'running' AND lease_until < ?",
            (JOB_KIND, now),
        ).fetchall()
        for row in expired:
            logger.warning("Recovering expired ingestion lease job_id=%s", row["id"])
        database.execute(
            """UPDATE jobs SET
                status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
                completed_at = CASE WHEN attempts >= ? THEN ? ELSE NULL END,
                error = 'Worker lease expired; previous attempt interrupted',
                lease_until = NULL, claim_token = NULL
                WHERE kind = ? AND status = 'running' AND lease_until < ?""",
            (MAX_ATTEMPTS, MAX_ATTEMPTS, now, JOB_KIND, now),
        )
        row = database.execute(
            "SELECT * FROM jobs WHERE kind = ? AND status = 'pending' AND available_at <= ? "
            "ORDER BY created_at, id LIMIT 1",
            (JOB_KIND, now),
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
        "Source job %s job_id=%s error=%s",
        "retry scheduled" if retry else "failed",
        job["id"],
        detail,
    )


def inspect(path: Path) -> dict:
    with connect(path) as database:
        jobs = [
            dict(row)
            for row in database.execute(
                "SELECT id, source_id, status, attempts, created_at, started_at, completed_at, "
                "error, result_json FROM jobs WHERE kind = ? ORDER BY created_at DESC LIMIT 20",
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
