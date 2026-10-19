"""Immutable per-location snapshots: the events one ingestion run kept for its 7-day window.

Every completed ingestion writes a snapshot (even with zero events); each new snapshot is
what triggers a new edition.
"""

import json
import sqlite3
import time
import uuid
from pathlib import Path

from projects.backend.shared.storage.database import connect


def record(
    database: sqlite3.Connection,
    location_id: str,
    job_id: str,
    window: tuple[str, str],
    events: list[dict],
    systems: list[dict],
    evidence_path: str,
) -> str:
    """Insert inside the caller's transaction. Each event needs source_id, source_event_id,
    event_date and facts."""
    identity = str(uuid.uuid4())
    database.execute(
        "INSERT INTO location_snapshots (id, location_id, job_id, window_start, window_end, "
        "created_at, event_count, systems_json, evidence_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            identity,
            location_id,
            job_id,
            window[0],
            window[1],
            time.time(),
            len(events),
            json.dumps(systems),
            evidence_path,
        ),
    )
    ordered = sorted(events, key=lambda event: (event["event_date"], event["source_event_id"]))
    database.executemany(
        "INSERT INTO snapshot_events VALUES (?, ?, ?, ?, ?, ?)",
        [
            (
                identity,
                position,
                event["source_id"],
                event["source_event_id"],
                event["event_date"],
                json.dumps(event["facts"]),
            )
            for position, event in enumerate(ordered)
        ],
    )
    return identity


def latest(path: Path, location_id: str) -> dict | None:
    with connect(path) as database:
        row = database.execute(
            "SELECT * FROM location_snapshots WHERE location_id = ? "
            "ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (location_id,),
        ).fetchone()
    return dict(row) if row else None


def events(path: Path, snapshot_id: str) -> list[dict]:
    """Snapshot events in date order (earliest first)."""
    with connect(path) as database:
        rows = database.execute(
            "SELECT source_id, source_event_id, event_date, facts_json FROM snapshot_events "
            "WHERE snapshot_id = ? ORDER BY position",
            (snapshot_id,),
        ).fetchall()
    return [
        {
            "source_id": row["source_id"],
            "source_event_id": row["source_event_id"],
            "event_date": row["event_date"],
            "facts": json.loads(row["facts_json"]),
        }
        for row in rows
    ]
