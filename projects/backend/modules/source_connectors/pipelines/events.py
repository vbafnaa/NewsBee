import hashlib
import json
import logging
import sqlite3
import time
import uuid
from datetime import UTC, datetime

import httpx

from projects.backend.modules.source_connectors.connectors.spl_rss import (
    MAX_FEED_BYTES,
    FeedFormatError,
    SourceConfig,
    parse_feed,
)
from projects.backend.shared.configuration.settings import ROOT, Settings
from projects.backend.shared.storage.database import connect

logger = logging.getLogger(__name__)


def load_source(source_id: str) -> SourceConfig:
    if source_id != "spl-capitol-hill":
        raise ValueError(f"Source is not onboarded: {source_id}")
    return SourceConfig.model_validate_json(
        (ROOT / "config" / "sources" / "spl-capitol-hill.json").read_text(encoding="utf-8")
    )


def fetch_feed(source: SourceConfig, client: httpx.Client) -> bytes:
    with client.stream(
        "GET",
        source.feed_url,
        headers={
            "User-Agent": "Newsbee-LocalPrototype/0.1 (manual library RSS evaluation)",
            "Accept": "application/rss+xml, application/xml, text/xml",
        },
    ) as response:
        response.raise_for_status()
        chunks = []
        size = 0
        for chunk in response.iter_bytes():
            size += len(chunk)
            if size > MAX_FEED_BYTES:
                raise FeedFormatError("RSS exceeds the 2 MiB ingestion limit")
            chunks.append(chunk)
        return b"".join(chunks)


def ingest(settings: Settings, job: dict, client: httpx.Client) -> None:
    started = time.monotonic()
    source = load_source(job["source_id"])
    content = fetch_feed(source, client)
    events, skipped, closures = parse_feed(content, source)
    retrieved = datetime.now(UTC).isoformat()
    envelope = {
        "source_id": source.id,
        "community_id": source.community_id,
        "feed_url": source.feed_url,
        "retrieved_at": retrieved,
        "response_sha256": hashlib.sha256(content).hexdigest(),
        "usage": source.usage,
        "redistribution_permission": source.redistribution_permission,
        "events": [event.model_dump() for event in events],
    }
    evidence_dir = settings.evidence_dir / source.id
    evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = evidence_dir / f"{job['id']}-{uuid.uuid4()}.json"
    summary = {
        "event_count": len(events),
        "skipped_other_venues": skipped,
        "skipped_library_closures": closures,
        "duration_seconds": round(time.monotonic() - started, 3),
        "evidence_path": str(evidence.relative_to(settings.data_dir)),
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
            for event in events:
                database.execute(
                    """INSERT INTO source_events VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(source_id, source_event_id, event_date) DO UPDATE SET
                        facts_json = excluded.facts_json, retrieved_at = excluded.retrieved_at,
                        evidence_path = excluded.evidence_path""",
                    (
                        source.id,
                        event.source_event_id,
                        event.event_date,
                        source.community_id,
                        event.model_dump_json(),
                        retrieved,
                        summary["evidence_path"],
                    ),
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
        "Source job completed job_id=%s events=%s skipped_venues=%s "
        "skipped_closures=%s duration_seconds=%s",
        job["id"],
        len(events),
        skipped,
        closures,
        summary["duration_seconds"],
    )
