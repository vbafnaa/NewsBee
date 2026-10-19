import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

SCHEMA_VERSION = 3


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
        if version not in {0, 1, 2, SCHEMA_VERSION}:
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
                result_json TEXT
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS edition_draft_entries (
                edition_id TEXT NOT NULL REFERENCES edition_drafts(id),
                position INTEGER NOT NULL,
                source_id TEXT NOT NULL,
                source_event_id TEXT NOT NULL,
                event_date TEXT NOT NULL,
                disposition TEXT NOT NULL CHECK (disposition IN ('held', 'template_validated')),
                result_json TEXT NOT NULL,
                PRIMARY KEY (edition_id, position)
            )"""
        )
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
