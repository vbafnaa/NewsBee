"""Onboarded locations: a town, every library system with a venue there, and their websites."""

import json
import logging
import time
from pathlib import Path

import httpx

from projects.backend.modules.communities import directory, wikidata
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
) -> dict:
    """Save (or refresh) a location from the directory, resolving each system's website.

    A reviewed override wins over Wikidata so a known-bad match can also be corrected.
    """
    profile = directory.place(directory.directory_path(data_dir), identity)
    overrides = website_overrides() if overrides is None else overrides
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
