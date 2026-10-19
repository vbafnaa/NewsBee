"""Run source agents for every onboarded location and summarise per-location status."""

from pathlib import Path

from projects.backend.modules.communities import locations
from projects.backend.modules.editions import drafting
from projects.backend.modules.orchestration import jobs
from shared.contracts.health import LocationStatus


def enqueue_all(database: Path) -> dict[str, str]:
    """Queue one ingestion job per onboarded location; returns location id -> job id."""
    return {
        location["id"]: jobs.enqueue(database, location["id"])
        for location in locations.list_all(database)
    }


def statuses(database: Path) -> list[LocationStatus]:
    published = {listing.location_id: listing for listing in drafting.listings(database)}
    return [
        LocationStatus(
            id=location["id"],
            name=location["name"],
            library_systems=len(location["systems"]),
            websites_resolved=sum(bool(system.get("website")) for system in location["systems"]),
            latest_ingestion=jobs.latest_run(database, location["id"]),
            latest_edition_id=published[location["id"]].edition_id,
            latest_edition_published_at=published[location["id"]].published_at,
        )
        for location in locations.list_all(database)
    ]
