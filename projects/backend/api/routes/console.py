import logging
import sqlite3
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from projects.backend.api.dependencies.services import get_settings
from projects.backend.modules.editions.drafting import inspect_editions
from projects.backend.modules.orchestration.jobs import inspect
from projects.backend.modules.source_connectors.connectors.common import https_link
from projects.backend.shared.configuration.settings import ROOT, Settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/review")
templates = Jinja2Templates(directory=ROOT / "projects" / "review-console" / "templates")


def timestamp(value: float | None) -> str:
    return datetime.fromtimestamp(value, UTC).isoformat() if value is not None else "Not recorded"


templates.env.filters["timestamp"] = timestamp
templates.env.filters["source_link"] = https_link


@router.get("", response_class=HTMLResponse)
def review(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


@router.get("/ingestion", response_class=HTMLResponse)
def ingestion(request: Request, settings: Annotated[Settings, Depends(get_settings)]):
    try:
        report = inspect(settings.database)
    except (sqlite3.Error, OSError, ValueError):
        logger.exception("Ingestion inspection unavailable")
        return templates.TemplateResponse(
            request=request, name="ingestion.html", context={"report": None}, status_code=503
        )
    return templates.TemplateResponse(
        request=request, name="ingestion.html", context={"report": report}
    )


@router.get("/editions", response_class=HTMLResponse)
def editions(request: Request, settings: Annotated[Settings, Depends(get_settings)]):
    try:
        report = inspect_editions(settings.database)
    except (sqlite3.Error, OSError, ValueError):
        logger.exception("Edition audit unavailable")
        return templates.TemplateResponse(
            request=request, name="editions.html", context={"report": None}, status_code=503
        )
    return templates.TemplateResponse(
        request=request, name="editions.html", context={"report": report}
    )
