import logging
import sqlite3
import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, StringConstraints

from projects.backend.api.dependencies.services import get_settings
from projects.backend.modules.communities import directory
from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.storage.database import connect

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/locations")


@router.get("/search")
def search(
    settings: Annotated[Settings, Depends(get_settings)],
    q: Annotated[str, Query(max_length=80)] = "",
) -> dict:
    """Town typeahead over the local library directory; ', ST' narrows to one state."""
    try:
        results = directory.search(directory.directory_path(settings.data_dir), q)
    except directory.DirectoryUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except sqlite3.Error as error:
        logger.exception("Library directory search failed")
        raise HTTPException(status_code=503, detail="Library directory unreadable") from error
    return {"query": q, "results": results}


def resolve(settings: Settings, location_id: str) -> dict[str, str]:
    try:
        profile = directory.place(directory.directory_path(settings.data_dir), location_id)
    except directory.DirectoryUnavailableError as error:
        raise HTTPException(503, str(error)) from error
    except sqlite3.Error as error:
        logger.exception("Library directory lookup failed")
        raise HTTPException(503, "Library directory unreadable") from error
    except LookupError as error:
        raise HTTPException(404, "Unknown location") from error
    return {"id": profile["id"], "name": profile["name"]}


@router.get("/{location_id}")
def location(
    location_id: str, settings: Annotated[Settings, Depends(get_settings)]
) -> dict[str, str]:
    return resolve(settings, location_id)


class ExpansionSignup(BaseModel):
    email: Annotated[
        str,
        StringConstraints(strip_whitespace=True, to_lower=True),
        Field(max_length=254, pattern=r"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$"),
    ]


@router.post("/{location_id}/interest")
def signup(
    location_id: str,
    signup: ExpansionSignup,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, str]:
    profile = resolve(settings, location_id)
    try:
        with connect(settings.database) as connection:
            connection.execute(
                "INSERT INTO expansion_signups (location_id, location_name, email, created_at) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(location_id, email) DO NOTHING",
                (location_id, profile["name"], signup.email, time.time()),
            )
    except sqlite3.Error as error:
        logger.exception("Expansion signup could not be saved")
        raise HTTPException(503, "Signup could not be saved. Please try again.") from error
    return {"status": "saved"}
