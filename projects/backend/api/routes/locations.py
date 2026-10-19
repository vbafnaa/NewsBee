import logging
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from projects.backend.api.dependencies.services import get_settings
from projects.backend.modules.communities import directory
from projects.backend.shared.configuration.settings import Settings

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
