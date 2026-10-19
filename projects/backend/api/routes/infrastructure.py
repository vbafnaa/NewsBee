import logging
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from projects.backend.api.dependencies.services import get_model, get_settings
from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.model_inference.ollama import ModelRuntime
from projects.backend.shared.observability.health import collect_health
from projects.backend.shared.observability.metrics import collect_metrics
from shared.contracts.health import HealthReport
from shared.contracts.metrics import MetricsReport

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


@router.get("/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get(
    "/health",
    response_model=HealthReport,
    responses={503: {"model": HealthReport, "description": "Dependencies degraded"}},
)
async def health(
    settings: Annotated[Settings, Depends(get_settings)],
    model: Annotated[ModelRuntime, Depends(get_model)],
) -> JSONResponse:
    report = await collect_health(settings, model)
    return JSONResponse(report.model_dump(), status_code=200 if report.status == "ok" else 503)


@router.get(
    "/metrics",
    response_model=MetricsReport,
    responses={503: {"description": "Local storage unavailable"}},
)
def metrics(
    settings: Annotated[Settings, Depends(get_settings)],
    days: Annotated[int, Query(ge=1, le=30)] = 7,
) -> MetricsReport:
    try:
        return collect_metrics(settings.database, window_days=days)
    except (sqlite3.Error, OSError, ValueError) as error:
        logger.exception("Metrics unavailable")
        raise HTTPException(status_code=503, detail="Metrics unavailable") from error
