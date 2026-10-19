"""Reader-facing editions: every onboarded location and its latest published edition."""

import logging
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from projects.backend.api.dependencies.services import get_settings
from projects.backend.modules.editions import drafting
from projects.backend.shared.configuration.settings import Settings
from shared.contracts.health import Edition, EditionsResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/editions")


@router.get("", response_model=EditionsResponse)
def editions(settings: Annotated[Settings, Depends(get_settings)]) -> EditionsResponse:
    try:
        return EditionsResponse(locations=drafting.listings(settings.database))
    except (sqlite3.Error, OSError, ValueError) as error:
        logger.exception("Editions listing unavailable")
        raise HTTPException(503, "Editions unavailable") from error


@router.get("/{location_id}", response_model=Edition, responses={404: {}, 503: {}})
def edition(location_id: str, settings: Annotated[Settings, Depends(get_settings)]) -> Edition:
    try:
        published = drafting.latest_published(settings.database, location_id)
    except (sqlite3.Error, OSError, ValueError, KeyError) as error:
        logger.exception("Edition unavailable location_id=%s", location_id)
        raise HTTPException(503, "Edition unavailable") from error
    except LookupError as error:
        raise HTTPException(404, f"Unknown location: {location_id}") from error
    if published is None:
        raise HTTPException(404, "No edition yet")
    return published
