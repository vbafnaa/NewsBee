import logging
import sqlite3
from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from projects.backend.api.dependencies.services import get_settings
from projects.backend.modules.orchestration.jobs import inspect
from projects.backend.shared.configuration.settings import ROOT, Settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/review")
templates = Jinja2Templates(directory=ROOT / "projects" / "review-console" / "templates")


def timestamp(value: float | None) -> str:
    return datetime.fromtimestamp(value, UTC).isoformat() if value is not None else "Not recorded"


def source_link(value: str) -> str | None:
    url = urlsplit(value)
    if (
        url.scheme == "https"
        and url.hostname == "www.spl.org"
        and not url.username
        and not url.password
    ):
        return value
    return None


templates.env.filters["timestamp"] = timestamp
templates.env.filters["source_link"] = source_link


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
