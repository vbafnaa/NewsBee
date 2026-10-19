import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

SCHEMA_VERSION = 9


@contextmanager
def connect(path: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(path, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        with connection:
            yield connection
    finally:
        connection.close()


def initialize(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version not in range(SCHEMA_VERSION + 1):
            raise RuntimeError(f"Unsupported database schema version: {version}")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS worker_heartbeat (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                updated_at REAL NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL
                    CHECK (status IN ('pending', 'running', 'failed', 'completed')),
                created_at REAL NOT NULL,
                completed_at REAL,
                error TEXT
            )"""
        )
        if version < 2:
            for definition in (
                "source_id TEXT",
                "attempts INTEGER NOT NULL DEFAULT 0",
                "available_at REAL NOT NULL DEFAULT 0",
                "lease_until REAL",
                "claim_token TEXT",
                "started_at REAL",
                "result_json TEXT",
            ):
                connection.execute(f"ALTER TABLE jobs ADD COLUMN {definition}")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS source_events (
                source_id TEXT NOT NULL,
                source_event_id TEXT NOT NULL,
                event_date TEXT NOT NULL,
                community_id TEXT NOT NULL,
                facts_json TEXT NOT NULL,
                retrieved_at TEXT NOT NULL,
                evidence_path TEXT NOT NULL,
                PRIMARY KEY (source_id, source_event_id, event_date)
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS edition_drafts (
                id TEXT PRIMARY KEY,
                community_id TEXT NOT NULL,
                window_start TEXT NOT NULL,
                window_end TEXT NOT NULL,
                model TEXT NOT NULL,
                validation_policy TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('running', 'failed', 'completed')),
                created_at REAL NOT NULL,
                completed_at REAL,
                error TEXT,
                result_json TEXT,
                snapshot_id TEXT
            )"""
        )
        draft_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(edition_drafts)")
        }
        if "snapshot_id" not in draft_columns:
            connection.execute("ALTER TABLE edition_drafts ADD COLUMN snapshot_id TEXT")
        if version == 3:
            connection.execute(
                "ALTER TABLE edition_draft_entries RENAME TO edition_draft_entries_v3"
            )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS edition_draft_entries (
                edition_id TEXT NOT NULL REFERENCES edition_drafts(id),
                position INTEGER NOT NULL,
                source_id TEXT NOT NULL,
                source_event_id TEXT NOT NULL,
                event_date TEXT NOT NULL,
                disposition TEXT NOT NULL
                    CHECK (disposition IN ('held', 'template_validated', 'checks_passed')),
                result_json TEXT NOT NULL,
                PRIMARY KEY (edition_id, position)
            )"""
        )
        if version == 3:
            connection.execute(
                "INSERT INTO edition_draft_entries SELECT * FROM edition_draft_entries_v3"
            )
            connection.execute("DROP TABLE edition_draft_entries_v3")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS locations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                profile_json TEXT NOT NULL,
                onboarded_at REAL NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS expansion_signups (
                location_id TEXT NOT NULL,
                location_name TEXT NOT NULL,
                email TEXT NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (location_id, email)
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS location_snapshots (
                id TEXT PRIMARY KEY,
                location_id TEXT NOT NULL,
                job_id TEXT NOT NULL,
                window_start TEXT NOT NULL,
                window_end TEXT NOT NULL,
                created_at REAL NOT NULL,
                event_count INTEGER NOT NULL,
                systems_json TEXT NOT NULL,
                evidence_path TEXT NOT NULL
            )"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS location_snapshots_latest "
            "ON location_snapshots (location_id, created_at)"
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS snapshot_events (
                snapshot_id TEXT NOT NULL REFERENCES location_snapshots(id),
                position INTEGER NOT NULL,
                source_id TEXT NOT NULL,
                source_event_id TEXT NOT NULL,
                event_date TEXT NOT NULL,
                facts_json TEXT NOT NULL,
                PRIMARY KEY (snapshot_id, position)
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS email_deliveries (
                edition_id TEXT NOT NULL REFERENCES edition_drafts(id),
                address TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'superseded')),
                attempts INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                updated_at REAL NOT NULL,
                sent_at REAL,
                PRIMARY KEY (edition_id, address)
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS story_cache (
                cache_key TEXT PRIMARY KEY,
                community_id TEXT NOT NULL,
                result_json TEXT NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS story_withdrawals (
                community_id TEXT NOT NULL,
                story_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at REAL NOT NULL,
                source_refs_json TEXT NOT NULL DEFAULT '[]',
                PRIMARY KEY (community_id, story_id)
            )"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS editions_latest "
            "ON edition_drafts (community_id, status, completed_at DESC)"
        )
        if 0 < version < 5:
            # v5 keys events and drafts by onboarded location; single-source data is dropped.
            connection.execute("DELETE FROM edition_draft_entries")
            connection.execute("DELETE FROM edition_drafts")
            connection.execute("DELETE FROM source_events")
            connection.execute("DELETE FROM jobs WHERE kind = 'ingest_events'")
        connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def heartbeat(path: Path) -> None:
    with connect(path) as connection:
        connection.execute(
            """INSERT INTO worker_heartbeat (id, updated_at) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at""",
            (time.time(),),
        )


def snapshot(path: Path) -> tuple[float | None, dict[str, int], float | None]:
    if not path.is_file():
        raise FileNotFoundError(f"Database not initialized: {path}")
    with connect(path) as connection:
        row = connection.execute("SELECT updated_at FROM worker_heartbeat WHERE id = 1").fetchone()
        counts = {status: 0 for status in ("pending", "running", "failed", "completed")}
        for job in connection.execute("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status"):
            counts[job["status"]] = job["count"]
        completed = connection.execute(
            "SELECT MAX(completed_at) FROM jobs WHERE status = 'completed'"
        ).fetchone()[0]
        return (row["updated_at"] if row else None, counts, completed)
