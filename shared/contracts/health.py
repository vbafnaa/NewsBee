from typing import Literal

from pydantic import BaseModel, Field


class ComponentHealth(BaseModel):
    status: Literal["ok", "unavailable", "not_configured"]
    detail: str


class HealthReport(BaseModel):
    status: Literal["ok", "degraded"]
    components: dict[str, ComponentHealth]
    jobs: dict[str, int] | None = None
    last_completed_job_at: float | None = None
    pipelines: Literal["not_implemented"] = "not_implemented"
    held_reviews: int | None = None
    publication: Literal["not_implemented"] = "not_implemented"


class EditionsResponse(BaseModel):
    status: Literal["not_implemented"] = "not_implemented"
    editions: list[dict[str, str]] = Field(default_factory=list)
