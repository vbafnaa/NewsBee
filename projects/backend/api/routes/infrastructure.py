from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from projects.backend.api.dependencies.services import get_model, get_settings
from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.model_inference.ollama import ModelRuntime
from projects.backend.shared.observability.health import collect_health
from shared.contracts.health import EditionsResponse, HealthReport

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


@router.get("/editions", response_model=EditionsResponse)
def editions() -> EditionsResponse:
    return EditionsResponse()
