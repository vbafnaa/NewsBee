"""Author and publish one edition per location snapshot, with no human review step.

Pipeline: snapshot events -> stories (repeats collapsed) -> rank every story by its
source's rules, keeping the top TOP_PER_SOURCE -> model newsworthiness ranking across sources ->
write items best-first, each source's best story first (falling to its next story if held),
with no per-category limit, until MAX_ENTRIES pass the checks or MAX_ATTEMPTS have been
written -> edition headline and
intro. Items are shown in rank order. Held items are excluded and never block publishing.
A snapshot with no usable events still publishes an edition.

Local stories (town events, meetings, and wider-source items that name the town) are written
first. County and statewide stories (news deserts' fallback) then fill remaining slots, up to
MAX_WIDER, and are shown after local ones with a section label saying where they are from.
"""

import hashlib
import json
import logging
import time
import uuid
from dataclasses import asdict
from pathlib import Path

import httpx

from projects.backend.modules.communities import locations
from projects.backend.modules.editions import stories
from projects.backend.modules.editorial.corrections import withdrawals
from projects.backend.modules.editorial.publication_checks import policy
from projects.backend.modules.source_connectors import ranking as source_ranking
from projects.backend.modules.source_connectors.connectors.common import https_link
from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.model_inference import newsworthiness, story_writer
from projects.backend.shared.model_inference.ollama import OllamaRuntime
from projects.backend.shared.storage import snapshots
from projects.backend.shared.storage.database import connect
from shared.contracts.health import (
    CorrectionNotice,
    Edition,
    EditionItem,
    EditionListing,
    EditionRun,
)

logger = logging.getLogger(__name__)
DEFAULT_MODEL = "qwen3:4b"
VALIDATION_POLICY = f"{newsworthiness.RANKING_POLICY}+{story_writer.WRITING_POLICY}+{policy.POLICY}"
MAX_ENTRIES = 9
MAX_ATTEMPTS = 12
# Wider-area (county or state) stories fill only slots local news leaves, at most about
# 40% of a full edition, with their own attempt budget so local attempts never starve them.
MAX_WIDER = 4
MAX_WIDER_ATTEMPTS = 6
WIDER_TIERS = frozenset({"region", "state"})
WIDER_SOURCES = ("hazards:", "statenews:", "trending:")
TOP_PER_SOURCE = 5


def candidates(story_list: list[stories.Story]) -> list[dict]:
    return [
        {
            "id": story.id,
            "title": story.title,
            "description": story.description,
            "occurrences": len(story.occurrences),
            "venues": story.venues,
            "first_date": story.first.event_date,
            "kind": story.kind,
            "tier": story.facts.get("tier", "local"),
        }
        for story in story_list
    ]


def shortlist(story_list: list[stories.Story]) -> tuple[list[stories.Story], dict]:
    """Each source type's best stories by its own rules, so every source can compete."""
    groups: dict[str, list[stories.Story]] = {}
    for story in story_list:
        groups.setdefault(source_ranking.source_type(story.first.source_id), []).append(story)
    chosen: list[stories.Story] = []
    summary: dict[str, dict] = {}
    for kind in sorted(groups):
        top = source_ranking.rank(kind, groups[kind])[:TOP_PER_SOURCE]
        chosen += top
        summary[kind] = {
            "stories": len(groups[kind]),
            "considered": len(groups[kind]),
            "shortlisted": len(top),
        }
    return chosen, summary


def next_candidate(pending: list[dict], source_of: dict[str, str], covered: set[str]) -> dict:
    """Best-ranked story from a source with nothing in the edition yet; otherwise the
    best-ranked story left. Only the writing order changes; no story is ruled out."""
    for candidate in pending:
        if source_of[candidate["id"]] not in covered:
            return candidate
    return pending[0]


def story_record(story: stories.Story) -> dict:
    return {
        "id": story.id,
        "title": story.title,
        "description": story.description,
        "kind": story.kind,
        "occurrences": [asdict(item) for item in story.occurrences],
    }


async def checked_item(settings: Settings, runtime: OllamaRuntime, candidate: dict) -> dict:
    """Reuse only successful prose with identical evidence, model and validation policy."""
    content = {key: candidate.get(key) for key in ("title", "description", "venues", "kind")}
    key = hashlib.sha256(
        json.dumps(
            [settings.ollama_model or DEFAULT_MODEL, VALIDATION_POLICY, content],
            sort_keys=True,
        ).encode()
    ).hexdigest()
    key = f"{candidate['community_id']}:{key}"
    with connect(settings.database) as database:
        cached = database.execute(
            "SELECT result_json FROM story_cache WHERE cache_key = ?", (key,)
        ).fetchone()
    if cached:
        result = json.loads(cached["result_json"])
        draft = story_writer.ItemDraft.model_validate(result["draft"])
        if not story_writer.validate_item(candidate, draft):
            return {**result, "cache_hit": True, "wall_seconds": 0.0}
        logger.warning("Cached draft failed current checks cache_key=%s", key)
    result = await story_writer.write_item(runtime, candidate)
    if result["disposition"] == "checks_passed":
        with connect(settings.database) as database:
            database.execute(
                "INSERT OR REPLACE INTO story_cache VALUES (?, ?, ?)",
                (key, candidate["community_id"], json.dumps(result)),
            )
    return {**result, "cache_hit": False}


class ModelNotReady(RuntimeError):
    """The local model runtime is unavailable; authoring can be retried later."""


class NoSnapshot(LookupError):
    """The location has not been ingested yet."""


def _finish(path: Path, identity: str, status: str, error: str | None, result: dict | None):
    with connect(path) as database:
        database.execute(
            "UPDATE edition_drafts SET status = ?, completed_at = ?, error = ?, result_json = ? "
            "WHERE id = ?",
            (status, time.time(), error, json.dumps(result) if result else None, identity),
        )


def published_for(path: Path, snapshot_id: str) -> str | None:
    with connect(path) as database:
        row = database.execute(
            "SELECT id FROM edition_drafts WHERE snapshot_id = ? AND status = 'completed'",
            (snapshot_id,),
        ).fetchone()
    return row["id"] if row else None


async def _check_model(runtime: OllamaRuntime, model: str) -> None:
    try:
        health = await runtime.health()
    except httpx.HTTPError as error:
        raise ModelNotReady(f"Ollama unreachable: {error}. Start Ollama.") from error
    if health.status != "ok":
        raise ModelNotReady(f"{health.detail}. Start Ollama and pull {model} first.")


async def author_edition(settings: Settings, location_id: str) -> EditionRun:
    """Publish an edition for the location's latest snapshot (idempotent per snapshot)."""
    location = locations.get(settings.database, location_id)
    snapshot = snapshots.latest(settings.database, location_id)
    if snapshot is None:
        raise NoSnapshot(f"No snapshot for {location_id}; run ingest-events first")
    existing = published_for(settings.database, snapshot["id"])
    if existing:
        logger.info(
            "Edition already published edition_id=%s snapshot_id=%s", existing, snapshot["id"]
        )
        return run_by_id(settings.database, existing)
    community = location["name"].split(",")[0]
    model = settings.ollama_model or DEFAULT_MODEL
    events = snapshots.events(settings.database, snapshot["id"])
    started = time.monotonic()
    async with httpx.AsyncClient(trust_env=False, timeout=10) as client:
        runtime = OllamaRuntime(client, settings.ollama_url, model)
        if events:
            await _check_model(runtime, model)
        identity = str(uuid.uuid4())
        with connect(settings.database) as database:
            database.execute(
                "INSERT INTO edition_drafts (id, community_id, window_start, window_end, model, "
                "validation_policy, status, created_at, snapshot_id) "
                "VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)",
                (
                    identity,
                    location_id,
                    snapshot["window_start"],
                    snapshot["window_end"],
                    model,
                    VALIDATION_POLICY,
                    time.time(),
                    snapshot["id"],
                ),
            )
        logger.info(
            "Edition authoring started edition_id=%s location_id=%s snapshot_id=%s "
            "window=%s..%s snapshot_events=%s model=%s policy=%s",
            identity,
            location_id,
            snapshot["id"],
            snapshot["window_start"],
            snapshot["window_end"],
            len(events),
            model,
            VALIDATION_POLICY,
        )
        all_stories = stories.collapse(events)
        story_list, sources = shortlist(all_stories)
        by_id = {story.id: story for story in story_list}
        withdrawn = withdrawals.for_location(settings.database, location_id)
        source_of = {
            story.id: source_ranking.source_type(story.first.source_id) for story in story_list
        }
        passed: list[tuple[int, dict, dict]] = []
        held = attempted = 0
        covered: set[str] = set()
        ranking = None
        try:
            ranked, ranking = await newsworthiness.rank(runtime, candidates(story_list))
            ranking["sources"] = sources
            logger.info(
                "Edition ranking edition_id=%s events=%s stories=%s ranked=%s fallback_ratings=%s "
                "wall_seconds=%s sources=%s",
                identity,
                len(events),
                len(all_stories),
                len(story_list),
                ranking["fallback_ratings"],
                ranking["wall_seconds"],
                json.dumps(sources),
            )
            rank_of = {candidate["id"]: rank for rank, candidate in enumerate(ranked, start=1)}
            local = [c for c in ranked if c["tier"] not in WIDER_TIERS]
            # Wider stories only fill what local news leaves: nearest tier first, then rank.
            wider = sorted(
                (c for c in ranked if c["tier"] in WIDER_TIERS),
                key=lambda c: (c["tier"] != "region", rank_of[c["id"]]),
            )
            wider_attempted = wider_passed = 0

            async def attempt(candidate: dict) -> bool:
                nonlocal held, attempted
                rank = rank_of[candidate["id"]]
                story = by_id[candidate["id"]]
                candidate["community_id"] = location_id
                eligibility = policy.errors(candidate) + policy.source_errors(
                    [item.source_url for item in story.occurrences]
                )
                if withdrawals.matching(story_record(story), withdrawn):
                    eligibility.append("previously_withdrawn")
                if eligibility:
                    logger.warning(
                        "Story held before writing story_id=%s errors=%s", story.id, eligibility
                    )
                    result = {
                        "disposition": "held",
                        "checks_passed": False,
                        "validation_errors": eligibility,
                        "attempts": 0,
                        "wall_seconds": 0.0,
                    }
                else:
                    result = await checked_item(settings, runtime, candidate)
                result.update(
                    story=story_record(story),
                    ranking={
                        "rank": rank,
                        "score": candidate["score"],
                        "rated_by": candidate["rated_by"],
                        **candidate["rating"],
                    },
                    when_where=stories.when_where(story),
                    source_url=story.first.source_url,
                    tier=candidate["tier"],
                    section=story.facts.get("section"),
                )
                ok = result["disposition"] == "checks_passed"
                if ok:
                    covered.add(source_of[candidate["id"]])
                    passed.append((rank, candidate, result["draft"]))
                else:
                    held += 1
                with connect(settings.database) as database:
                    database.execute(
                        "INSERT INTO edition_draft_entries VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            identity,
                            attempted,
                            story.first.source_id,
                            story.first.source_event_id,
                            story.first.event_date,
                            result["disposition"],
                            json.dumps(result),
                        ),
                    )
                attempted += 1
                logger.info(
                    "Edition item edition_id=%s story_id=%s rank=%s score=%s category=%s "
                    "tier=%s occurrences=%s attempts=%s disposition=%s errors=%s "
                    "wall_seconds=%s",
                    identity,
                    story.id,
                    rank,
                    candidate["score"],
                    candidate["rating"]["category"],
                    candidate["tier"],
                    len(story.occurrences),
                    result.get("attempts"),
                    result["disposition"],
                    result.get("validation_errors") or result.get("error"),
                    result["wall_seconds"],
                )
                return ok

            while local and len(passed) < MAX_ENTRIES and attempted < MAX_ATTEMPTS:
                candidate = next_candidate(local, source_of, covered)
                local.remove(candidate)
                await attempt(candidate)
            local_passed = len(passed)
            while (
                wider
                and len(passed) < MAX_ENTRIES
                and wider_passed < MAX_WIDER
                and wider_attempted < MAX_WIDER_ATTEMPTS
            ):
                candidate = next_candidate(wider, source_of, covered)
                wider.remove(candidate)
                wider_attempted += 1
                wider_passed += await attempt(candidate)
            # Local stories lead; wider stories follow, each group in rank order.
            passed.sort(key=lambda entry: (entry[1]["tier"] in WIDER_TIERS, entry[0]))
            week = stories.week_label(snapshot["window_start"], snapshot["window_end"])
            passed_stories = [candidate for _, candidate, _ in passed]
            passed_drafts = [draft for _, _, draft in passed]
            front = await story_writer.write_front(
                runtime, community, week, passed_stories, passed_drafts
            )
            email = await story_writer.write_email(
                runtime, community, week, passed_stories, passed_drafts, front
            )
            for label, text in (("front", front), ("email", email)):
                logger.info(
                    "Edition %s edition_id=%s fallback=%s errors=%s wall_seconds=%s",
                    label,
                    identity,
                    text["fallback"],
                    text["validation_errors"] or text.get("error"),
                    text["wall_seconds"],
                )
        except BaseException as error:
            detail = f"{type(error).__name__}: {error}"
            logger.exception("Edition authoring failed edition_id=%s", identity)
            _finish(settings.database, identity, "failed", detail, None)
            raise
        summary = {
            "included": len(passed),
            "local_included": local_passed,
            "wider_included": wider_passed,
            "wider_attempted": wider_attempted,
            "held": held,
            "attempted": attempted,
            "not_attempted": len(story_list) - attempted,
            "events": len(events),
            "stories": len(all_stories),
            "ranked": len(story_list),
            "ranking": ranking,
            "duration_seconds": round(time.monotonic() - started, 3),
            "front": front,
            "email": email,
        }
        _finish(settings.database, identity, "completed", None, summary)
    logger.info(
        "Edition published edition_id=%s location_id=%s included=%s held=%s attempted=%s "
        "front_fallback=%s duration_seconds=%s",
        identity,
        location_id,
        summary["included"],
        held,
        attempted,
        front["fallback"],
        summary["duration_seconds"],
    )
    return run_by_id(settings.database, identity)


def _run(row) -> EditionRun:
    result = json.loads(row["result_json"]) if row["result_json"] else {}
    front = result.get("front")
    return EditionRun(
        id=row["id"],
        community_id=row["community_id"],
        snapshot_id=row["snapshot_id"],
        window_start=row["window_start"],
        window_end=row["window_end"],
        model=row["model"],
        status=row["status"],
        error=row["error"],
        front_fallback=front["fallback"] if front else None,
        email_fallback=result["email"]["fallback"] if result.get("email") else None,
        **{
            key: result.get(key)
            for key in (
                "included",
                "held",
                "attempted",
                "not_attempted",
                "duration_seconds",
                "events",
                "stories",
                "skipped_for_variety",
                "ranked",
            )
        },
        ranking_fallback_ratings=(result.get("ranking") or {}).get("fallback_ratings"),
    )


def run_by_id(path: Path, identity: str) -> EditionRun:
    with connect(path) as database:
        row = database.execute("SELECT * FROM edition_drafts WHERE id = ?", (identity,)).fetchone()
    return _run(row)


def latest_run(path: Path, location_id: str | None = None) -> EditionRun | None:
    with connect(path) as database:
        row = database.execute(
            "SELECT * FROM edition_drafts WHERE ? IS NULL OR community_id = ? "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (location_id, location_id),
        ).fetchone()
    return _run(row) if row else None


def _latest_published_row(database, location_id: str):
    return database.execute(
        "SELECT * FROM edition_drafts WHERE community_id = ? AND status = 'completed' "
        "ORDER BY completed_at DESC, id DESC LIMIT 1",
        (location_id,),
    ).fetchone()


def listings(path: Path) -> list[EditionListing]:
    """Every onboarded location with its latest published edition, if any."""
    result = []
    onboarded = locations.list_all(path)
    with connect(path) as database:
        for location in onboarded:
            row = _latest_published_row(database, location["id"])
            result.append(
                EditionListing(
                    location_id=location["id"],
                    location_name=location["name"],
                    edition_id=row["id"] if row else None,
                    published_at=row["completed_at"] if row else None,
                    window_start=row["window_start"] if row else None,
                    window_end=row["window_end"] if row else None,
                )
            )
    return result


def latest_published(path: Path, location_id: str) -> Edition | None:
    """The reader-facing edition: front plus items that passed checks, best ranked first."""
    location = locations.get(path, location_id)
    with connect(path) as database:
        row = _latest_published_row(database, location_id)
        if row is None:
            return None
        entries = database.execute(
            "SELECT result_json FROM edition_draft_entries WHERE edition_id = ? "
            "AND disposition != 'held' ORDER BY position",
            (row["id"],),
        ).fetchall()
        snapshot = database.execute(
            "SELECT systems_json FROM location_snapshots WHERE id = ?", (row["snapshot_id"],)
        ).fetchone()
    front = json.loads(row["result_json"])["front"]
    withdrawn = withdrawals.for_location(path, location_id)
    corrections = []
    systems = json.loads(snapshot["systems_json"]) if snapshot else []
    source_names = {system["source_id"]: system["name"] for system in systems}
    items = []
    for entry in entries:
        result = json.loads(entry["result_json"])
        draft = result["draft"]
        story = result.get("story")
        notices = withdrawals.matching(story, withdrawn) if story else []
        if notices:
            corrections.extend(CorrectionNotice.model_validate(notice) for notice in notices)
            continue
        occurrence = story["occurrences"][0] if story else {}
        items.append(
            EditionItem(
                story_id=story["id"] if story else None,
                headline=draft["headline"],
                blurb=draft.get("summary") or draft.get("blurb"),
                when_where=result["when_where"],
                event_date=(
                    story["occurrences"][0]["event_date"]
                    if story
                    else result["facts"]["event_date"]
                ),
                source_url=https_link(
                    result.get("source_url") or result.get("facts", {}).get("source_url")
                ),
                rank=(result.get("ranking") or {}).get("rank"),
                kind=story.get("kind", "event") if story else "event",
                source_name=source_names.get(occurrence.get("source_id"), "Local source"),
                section=result.get("section"),
                local=result.get("tier", "local") not in WIDER_TIERS,
            )
        )
    if corrections:
        front = story_writer.fallback_front(
            location["name"].split(",")[0],
            stories.week_label(row["window_start"], row["window_end"]),
            bool(items),
        ).model_dump()
    coverage = [
        f"{system['name']}: coverage unavailable ({system['status']})."
        for system in systems
        if system["status"] != "ingested"
    ]
    if not systems:
        coverage.append("Source coverage was not recorded for this edition.")
    if not any(system["source_id"].startswith("meetings:") for system in systems):
        coverage.append("No public meeting source was checked for this edition.")
    wider = any(system["source_id"].startswith(WIDER_SOURCES) for system in systems)
    coverage.insert(
        0,
        "Private prototype: library listings, public meetings"
        + (", official state news and statewide trends" if wider else "")
        + " only, not all local news.",
    )
    # Town stories first; county and statewide ones after, each group best ranked first.
    items.sort(
        key=lambda item: (not item.local, item.rank if item.rank is not None else float("inf"))
    )
    return Edition(
        id=row["id"],
        location_id=location_id,
        location_name=location["name"],
        window_start=row["window_start"],
        window_end=row["window_end"],
        published_at=row["completed_at"],
        headline=front["headline"],
        intro=front["intro"],
        items=items,
        coverage=coverage,
        corrections=list({notice.story_id: notice for notice in corrections}.values()),
    )


def email_content(path: Path, edition_id: str) -> dict:
    """What an email preview of a published edition says; the website holds the full edition."""
    with connect(path) as database:
        row = database.execute(
            "SELECT community_id, result_json FROM edition_drafts "
            "WHERE id = ? AND status = 'completed'",
            (edition_id,),
        ).fetchone()
    if row is None:
        raise LookupError(f"No published edition: {edition_id}")
    result = json.loads(row["result_json"])
    name = locations.get(path, row["community_id"])["name"]
    email = result.get("email") or story_writer.fallback_email(name, True).model_dump()
    withdrawn = withdrawals.for_location(path, row["community_id"])
    with connect(path) as database:
        entries = database.execute(
            "SELECT result_json FROM edition_draft_entries WHERE edition_id = ? "
            "AND disposition != 'held'",
            (edition_id,),
        ).fetchall()
    affected = [
        story
        for entry in entries
        if (story := json.loads(entry["result_json"]).get("story"))
        and withdrawals.matching(story, withdrawn)
    ]
    if affected:
        front = story_writer.fallback_front(name, "updated edition", False)
        return {
            "location_id": row["community_id"],
            "location_name": name,
            "headline": front.headline,
            "intro": "This edition has been corrected. Read the website for the current stories.",
            "blurb": "A story was withdrawn; the correction notice is available with the edition.",
        }
    return {
        "location_id": row["community_id"],
        "location_name": name,
        "headline": result["front"]["headline"],
        "intro": result["front"]["intro"],
        "blurb": email["blurb"],
    }


def inspect_editions(path: Path) -> dict:
    """Audit view: latest run with included and held items, plus recent history."""
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
                "email": result.get("email"),
                "included": [entry for entry in entries if entry["disposition"] != "held"],
                "held": [entry for entry in entries if entry["disposition"] == "held"],
            }
    return {
        "latest": latest,
        "history": [_run(row).model_dump() for row in runs],
        "usage": "local_evaluation_only",
        "redistribution_permission": "unresolved",
    }
