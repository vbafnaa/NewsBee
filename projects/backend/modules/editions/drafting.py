"""Private draft edition: model-written news items gated by the rule-based claim check."""

import json
import logging
import time
import uuid
from datetime import date, timedelta
from pathlib import Path

import httpx

from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.model_inference.news_blurb import (
    VALIDATION_POLICY,
    EventFacts,
    draft_front,
    draft_item,
)
from projects.backend.shared.model_inference.ollama import OllamaRuntime
from projects.backend.shared.storage.database import connect
from shared.contracts.health import EditionDraftRun

logger = logging.getLogger(__name__)
DEFAULT_MODEL = "qwen3:1.7b"
COMMUNITY_ID = "capitol-hill-seattle"
WINDOW_DAYS = 7
MAX_ENTRIES = 50


def window(today: date) -> tuple[str, str]:
    return today.isoformat(), (today + timedelta(days=WINDOW_DAYS - 1)).isoformat()


def select_events(path: Path, start: str, end: str) -> list[dict]:
    with connect(path) as database:
        rows = database.execute(
            "SELECT source_id, source_event_id, event_date, facts_json FROM source_events "
            "WHERE community_id = ? AND event_date BETWEEN ? AND ? "
            "ORDER BY event_date, source_event_id",
            (COMMUNITY_ID, start, end),
        ).fetchall()
    return [dict(row) for row in rows]


def _finish(path: Path, identity: str, status: str, error: str | None, result: dict | None):
    with connect(path) as database:
        database.execute(
            "UPDATE edition_drafts SET status = ?, completed_at = ?, error = ?, result_json = ? "
            "WHERE id = ?",
            (status, time.time(), error, json.dumps(result) if result else None, identity),
        )


async def draft_edition(settings: Settings, today: date | None = None) -> EditionDraftRun:
    model = settings.ollama_model or DEFAULT_MODEL
    start, end = window(today or date.today())
    started = time.monotonic()
    async with httpx.AsyncClient(trust_env=False, timeout=10) as client:
        runtime = OllamaRuntime(client, settings.ollama_url, model)
        health = await runtime.health()
        if health.status != "ok":
            raise RuntimeError(f"{health.detail}. Start Ollama and pull {model} first.")
        events = select_events(settings.database, start, end)
        selected, skipped = events[:MAX_ENTRIES], max(0, len(events) - MAX_ENTRIES)
        identity = str(uuid.uuid4())
        with connect(settings.database) as database:
            database.execute(
                "INSERT INTO edition_drafts (id, community_id, window_start, window_end, model, "
                "validation_policy, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)",
                (identity, COMMUNITY_ID, start, end, model, VALIDATION_POLICY, time.time()),
            )
        logger.info(
            "Edition draft started edition_id=%s window=%s..%s events=%s skipped_over_limit=%s "
            "model=%s policy=%s",
            identity,
            start,
            end,
            len(selected),
            skipped,
            model,
            VALIDATION_POLICY,
        )
        passed: list[EventFacts] = []
        held = 0
        try:
            for position, event in enumerate(selected):
                stored = json.loads(event["facts_json"])
                facts = EventFacts.model_validate(
                    {name: stored.get(name) for name in EventFacts.model_fields}
                )
                result = await draft_item(runtime, facts)
                if result["disposition"] == "checks_passed":
                    passed.append(facts)
                else:
                    held += 1
                with connect(settings.database) as database:
                    database.execute(
                        "INSERT INTO edition_draft_entries VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            identity,
                            position,
                            event["source_id"],
                            event["source_event_id"],
                            event["event_date"],
                            result["disposition"],
                            json.dumps(result),
                        ),
                    )
                logger.info(
                    "Edition item edition_id=%s source_event_id=%s disposition=%s "
                    "errors=%s wall_seconds=%s",
                    identity,
                    facts.source_event_id,
                    result["disposition"],
                    result.get("validation_errors") or result.get("error"),
                    result["wall_seconds"],
                )
            front = await draft_front(runtime, passed)
            logger.info(
                "Edition front edition_id=%s fallback=%s errors=%s wall_seconds=%s",
                identity,
                front["fallback"],
                front["validation_errors"] or front.get("error"),
                front["wall_seconds"],
            )
        except BaseException as error:
            detail = f"{type(error).__name__}: {error}"
            logger.exception("Edition draft failed edition_id=%s", identity)
            _finish(settings.database, identity, "failed", detail, None)
            raise
        summary = {
            "included": len(passed),
            "held": held,
            "skipped_over_limit": skipped,
            "duration_seconds": round(time.monotonic() - started, 3),
            "front": front,
        }
        _finish(settings.database, identity, "completed", None, summary)
    logger.info(
        "Edition draft completed edition_id=%s included=%s held=%s front_fallback=%s "
        "duration_seconds=%s",
        identity,
        summary["included"],
        held,
        front["fallback"],
        summary["duration_seconds"],
    )
    return latest_draft(settings.database)


def _run(row) -> EditionDraftRun:
    result = json.loads(row["result_json"]) if row["result_json"] else {}
    front = result.get("front")
    return EditionDraftRun(
        id=row["id"],
        community_id=row["community_id"],
        window_start=row["window_start"],
        window_end=row["window_end"],
        model=row["model"],
        status=row["status"],
        error=row["error"],
        front_fallback=front["fallback"] if front else None,
        **{
            key: result.get(key)
            for key in ("included", "held", "skipped_over_limit", "duration_seconds")
        },
    )


def latest_draft(path: Path) -> EditionDraftRun | None:
    with connect(path) as database:
        row = database.execute(
            "SELECT * FROM edition_drafts ORDER BY created_at DESC, id DESC LIMIT 1"
        ).fetchone()
    return _run(row) if row else None


def inspect_drafts(path: Path) -> dict:
    with connect(path) as database:
        runs = database.execute(
            "SELECT * FROM edition_drafts ORDER BY created_at DESC, id DESC LIMIT 10"
        ).fetchall()
        latest = None
        if runs:
            entries = [
                {**dict(row), "result": json.loads(row["result_json"])}
                for row in database.execute(
                    "SELECT * FROM edition_draft_entries WHERE edition_id = ? ORDER BY position",
                    (runs[0]["id"],),
                )
            ]
            result = json.loads(runs[0]["result_json"]) if runs[0]["result_json"] else {}
            latest = {
                "run": _run(runs[0]).model_dump(),
                "validation_policy": runs[0]["validation_policy"],
                "front": result.get("front"),
                "included": [entry for entry in entries if entry["disposition"] != "held"],
                "held": [entry for entry in entries if entry["disposition"] == "held"],
            }
    return {
        "latest": latest,
        "history": [_run(row).model_dump() for row in runs],
        "usage": "local_evaluation_only",
        "redistribution_permission": "unresolved",
    }
