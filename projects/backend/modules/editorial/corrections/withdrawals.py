"""Append-only local withdrawals, applied to readers and subsequent authoring."""

import json
import logging
import time
from pathlib import Path

from projects.backend.shared.storage.database import connect

logger = logging.getLogger(__name__)


def for_location(path: Path, location_id: str) -> dict[str, dict]:
    with connect(path) as database:
        return {
            row["story_id"]: {
                **dict(row),
                "source_refs": json.loads(row["source_refs_json"]),
            }
            for row in database.execute(
                "SELECT * FROM story_withdrawals WHERE community_id = ? "
                "ORDER BY created_at, story_id",
                (location_id,),
            )
        }


def matching(story: dict, decisions: dict[str, dict]) -> list[dict]:
    references = {
        (item["source_id"], item["source_event_id"]) for item in story.get("occurrences", [])
    }
    return [
        decision
        for identity, decision in decisions.items()
        if story["id"] == identity
        or references.intersection(tuple(reference) for reference in decision["source_refs"])
    ]


def withdraw(path: Path, edition_id: str, story_id: str, reason: str) -> None:
    reason = reason.strip()
    if not 10 <= len(reason) <= 500:
        raise ValueError("A public correction reason must be 10-500 characters")
    with connect(path) as database:
        database.execute("BEGIN IMMEDIATE")
        edition = database.execute(
            "SELECT community_id FROM edition_drafts WHERE id = ? AND status = 'completed'",
            (edition_id,),
        ).fetchone()
        if edition is None:
            raise LookupError(f"No published edition: {edition_id}")
        entries = database.execute(
            "SELECT result_json FROM edition_draft_entries "
            "WHERE edition_id = ? AND disposition != 'held'",
            (edition_id,),
        ).fetchall()
        story = next(
            (
                item
                for entry in entries
                if (item := json.loads(entry["result_json"]).get("story", {})).get("id") == story_id
            ),
            None,
        )
        if story is None:
            raise LookupError(f"No published story {story_id} in edition {edition_id}")
        previous = database.execute(
            "SELECT reason FROM story_withdrawals WHERE community_id = ? AND story_id = ?",
            (edition["community_id"], story_id),
        ).fetchone()
        if previous:
            if previous["reason"] != reason:
                raise ValueError(
                    "Withdrawal already exists; its audit reason cannot be overwritten"
                )
            return
        database.execute(
            "INSERT INTO story_withdrawals VALUES (?, ?, ?, ?, ?)",
            (
                edition["community_id"],
                story_id,
                reason,
                time.time(),
                json.dumps(
                    [[item["source_id"], item["source_event_id"]] for item in story["occurrences"]]
                ),
            ),
        )
    logger.warning(
        "Story withdrawn edition_id=%s story_id=%s reason=%s", edition_id, story_id, reason
    )
