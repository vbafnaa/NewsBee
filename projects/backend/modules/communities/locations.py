"""Onboarded locations: a town, every library system with a venue there, their websites, and
the town's public meeting platform."""

import json
import logging
import shutil
import time
from pathlib import Path

import httpx

from projects.backend.modules.communities import directory, wikidata
from projects.backend.modules.source_connectors.agents import government_meetings
from projects.backend.shared.configuration.settings import ROOT
from projects.backend.shared.storage.database import connect

logger = logging.getLogger(__name__)
WEBSITE_OVERRIDES = ROOT / "config" / "library-websites.json"


def website_overrides(path: Path = WEBSITE_OVERRIDES) -> dict[str, dict]:
    """Reviewed websites for systems Wikidata cannot resolve, keyed by IMLS FSCS key."""
    if not path.exists():
        return {}
    entries = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(entries, dict):
        raise ValueError(f"{path.name} must map FSCS keys to {{name, website}}")
    for key, entry in entries.items():
        website = entry.get("website", "") if isinstance(entry, dict) else ""
        if not entry.get("name") or not website.startswith("https://"):
            raise ValueError(f"{path.name} entry {key} needs a name and an https:// website")
        entry["website"] = wikidata.https_origin(website)
    return entries


def _override_lookup(system: dict, entry: dict) -> dict:
    if entry["name"].casefold() != system["name"].casefold():
        raise ValueError(
            f"library-websites.json entry {system['fscskey']} is named {entry['name']!r}, "
            f"but the directory lists {system['name']!r}"
        )
    return {
        "status": "override",
        "website": entry["website"],
        "wikidata_id": None,
        "detail": "Website from config/library-websites.json",
    }


def onboard(
    data_dir: Path,
    database: Path,
    identity: str,
    client: httpx.Client,
    overrides: dict[str, dict] | None = None,
    government_overrides: dict[str, dict] | None = None,
) -> dict:
    """Save (or refresh) a location from the directory, resolving each system's website
    and the town's public meeting platform.

    A reviewed override wins over Wikidata so a known-bad match can also be corrected.
    """
    profile = directory.place(directory.directory_path(data_dir), identity)
    overrides = website_overrides() if overrides is None else overrides
    if government_overrides is None:
        government_overrides = government_meetings.overrides()
    for system in profile["systems"]:
        entry = overrides.get(system["fscskey"])
        system["website_lookup"] = (
            _override_lookup(system, entry) if entry else wikidata.lookup_website(client, system)
        )
        system["website"] = system["website_lookup"]["website"]
        logger.info(
            "Library system onboarded location_id=%s fscskey=%s website_status=%s detail=%s",
            identity,
            system["fscskey"],
            system["website_lookup"]["status"],
            system["website_lookup"]["detail"],
        )
    profile["government"] = government_meetings.discover(
        client, profile, government_overrides.get(identity)
    )
    logger.info(
        "Government meetings onboarded location_id=%s status=%s platform=%s tenant=%s detail=%s",
        identity,
        profile["government"]["status"],
        profile["government"]["platform"],
        profile["government"]["tenant"],
        profile["government"]["detail"],
    )
    save(database, profile)
    return profile


def save(database: Path, profile: dict) -> None:
    with connect(database) as connection:
        connection.execute(
            "INSERT OR REPLACE INTO locations (id, name, profile_json, onboarded_at) "
            "VALUES (?, ?, ?, ?)",
            (profile["id"], profile["name"], json.dumps(profile), time.time()),
        )


def get(database: Path, identity: str) -> dict:
    with connect(database) as connection:
        row = connection.execute(
            "SELECT profile_json FROM locations WHERE id = ?", (identity,)
        ).fetchone()
    if row is None:
        raise LookupError(f"Location is not onboarded: {identity}")
    return json.loads(row["profile_json"])


def list_all(database: Path) -> list[dict]:
    with connect(database) as connection:
        rows = connection.execute("SELECT profile_json FROM locations ORDER BY name").fetchall()
    return [json.loads(row["profile_json"]) for row in rows]


class LocationBusy(RuntimeError):
    """A job for the location is running; removal would race with the worker."""


def remove(database: Path, evidence_dir: Path, identity: str) -> dict[str, int]:
    """Delete a location and everything stored for it: jobs, events, snapshots, editions."""
    get(database, identity)
    with connect(database) as connection:
        running = connection.execute(
            "SELECT COUNT(*) FROM jobs WHERE source_id = ? AND status = 'running'", (identity,)
        ).fetchone()[0]
        if running:
            raise LocationBusy(f"{identity} has a running job; wait for it to finish")
        editions = "SELECT id FROM edition_drafts WHERE community_id = ?"
        snapshots = "SELECT id FROM location_snapshots WHERE location_id = ?"
        statements = {
            "story_cache": "DELETE FROM story_cache WHERE community_id = ?",
            "withdrawals": "DELETE FROM story_withdrawals WHERE community_id = ?",
            "email_deliveries": (f"DELETE FROM email_deliveries WHERE edition_id IN ({editions})"),
            "edition_entries": (
                f"DELETE FROM edition_draft_entries WHERE edition_id IN ({editions})"
            ),
            "editions": "DELETE FROM edition_drafts WHERE community_id = ?",
            "snapshot_events": f"DELETE FROM snapshot_events WHERE snapshot_id IN ({snapshots})",
            "snapshots": "DELETE FROM location_snapshots WHERE location_id = ?",
            "events": "DELETE FROM source_events WHERE community_id = ?",
            "jobs": "DELETE FROM jobs WHERE source_id = ?",
            "locations": "DELETE FROM locations WHERE id = ?",
        }
        counts = {
            name: connection.execute(sql, (identity,)).rowcount for name, sql in statements.items()
        }
    folder = evidence_dir / identity
    counts["evidence_files"] = sum(1 for item in folder.rglob("*") if item.is_file())
    if folder.is_dir():
        shutil.rmtree(folder)
    logger.info("Location removed location_id=%s counts=%s", identity, counts)
    return counts
