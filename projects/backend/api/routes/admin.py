import logging
import sqlite3
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from projects.backend.api.dependencies.admin import require_admin
from projects.backend.api.dependencies.services import get_settings
from projects.backend.modules.communities import locations
from projects.backend.modules.orchestration import jobs, orchestrator
from projects.backend.shared.configuration.settings import Settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin)])


class LibrarySourceSettings(BaseModel):
    fscskey: str
    website: str | None = Field(max_length=2048)

    @field_validator("website")
    @classmethod
    def secure_website(cls, value: str | None) -> str | None:
        if value is None:
            return None
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("Library source website must be a clean HTTPS URL")
        return value.rstrip("/")


class GovernmentSourceSettings(BaseModel):
    platform: Literal["legistar", "civicclerk"]
    tenant: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")


class LocationSourceUpdate(BaseModel):
    systems: list[LibrarySourceSettings]
    government: GovernmentSourceSettings | None


@router.get("/locations")
def list_locations(settings: Annotated[Settings, Depends(get_settings)]) -> dict:
    try:
        result = []
        for profile in locations.list_all(settings.database):
            result.append(
                {
                    "id": profile["id"],
                    "name": profile["name"],
                    "systems": [
                        {
                            "fscskey": system["fscskey"],
                            "name": system["name"],
                            "website": system.get("website"),
                        }
                        for system in profile["systems"]
                    ],
                    "government": profile.get("government"),
                }
            )
        return {"locations": result}
    except (sqlite3.Error, OSError, ValueError) as error:
        logger.exception("Admin location listing unavailable")
        raise HTTPException(503, "Location settings unavailable") from error


@router.patch("/locations/{identity}/sources")
def update_location_sources(
    identity: str,
    update: LocationSourceUpdate,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict:
    try:
        profile = locations.update_sources(
            settings.database,
            identity,
            {system.fscskey: system.website for system in update.systems},
            update.government.model_dump() if update.government else None,
        )
    except LookupError as error:
        raise HTTPException(404, "Location is not onboarded") from error
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except (sqlite3.Error, OSError) as error:
        logger.exception("Admin source update failed location_id=%s", identity)
        raise HTTPException(503, "Source settings could not be saved") from error
    return {"id": profile["id"], "name": profile["name"], "status": "saved"}


@router.get("/channels")
def list_channels(settings: Annotated[Settings, Depends(get_settings)]) -> dict:
    return {
        "channels": [
            {
                "id": "reader-site",
                "type": "website",
                "name": "Newsbee reader site",
                "url": settings.website_url,
                "enabled": True,
                "mode": "automatic",
            }
        ]
    }


@router.post("/ingestion")
def trigger_all_ingestion(settings: Annotated[Settings, Depends(get_settings)]) -> dict:
    try:
        queued = orchestrator.enqueue_all(settings.database)
    except (sqlite3.Error, OSError, ValueError) as error:
        logger.exception("Admin ingestion trigger failed")
        raise HTTPException(503, "Ingestion could not be queued") from error
    logger.info("Admin queued ingestion for %s locations", len(queued))
    return {
        "jobs": [
            {"location_id": location_id, "job_id": job_id}
            for location_id, job_id in queued.items()
        ]
    }


@router.post("/locations/{identity}/ingestion")
def trigger_location_ingestion(
    identity: str, settings: Annotated[Settings, Depends(get_settings)]
) -> dict:
    try:
        locations.get(settings.database, identity)
        job_id = jobs.enqueue(settings.database, identity)
    except LookupError as error:
        raise HTTPException(404, "Location is not onboarded") from error
    except (sqlite3.Error, OSError, ValueError) as error:
        logger.exception("Admin ingestion trigger failed location_id=%s", identity)
        raise HTTPException(503, "Ingestion could not be queued") from error
    logger.info("Admin queued ingestion location_id=%s job_id=%s", identity, job_id)
    return {"location_id": identity, "job_id": job_id}


@router.get("/jobs")
def recent_jobs(settings: Annotated[Settings, Depends(get_settings)]) -> dict:
    try:
        return {"jobs": jobs.recent(settings.database)}
    except (sqlite3.Error, OSError) as error:
        logger.exception("Admin job listing unavailable")
        raise HTTPException(503, "Job status unavailable") from error
