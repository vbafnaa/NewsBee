from typing import Literal

from pydantic import BaseModel, Field


class ComponentHealth(BaseModel):
    status: Literal["ok", "unavailable", "not_configured"]
    detail: str


class CapabilityReadiness(BaseModel):
    status: Literal["ready", "unavailable", "not_configured", "not_implemented"]
    detail: str


class IngestionRun(BaseModel):
    id: str
    source_id: str
    status: Literal["pending", "running", "failed", "completed"]
    attempts: int
    error: str | None
    event_count: int | None = None
    skipped_other_venues: int | None = None
    skipped_library_closures: int | None = None
    duration_seconds: float | None = None


class EditionDraftRun(BaseModel):
    id: str
    community_id: str
    window_start: str
    window_end: str
    model: str
    status: Literal["running", "failed", "completed"]
    error: str | None
    included: int | None = None
    held: int | None = None
    skipped_over_limit: int | None = None
    duration_seconds: float | None = None
    front_fallback: bool | None = None


class HealthReport(BaseModel):
    status: Literal["ok", "degraded"]
    components: dict[str, ComponentHealth]
    capabilities: dict[str, CapabilityReadiness]
    latest_ingestion: IngestionRun | None = None
    latest_edition_draft: EditionDraftRun | None = None
    jobs: dict[str, int] | None = None
    last_completed_job_at: float | None = None
    pipelines: Literal["local_event_ingestion_only"] = "local_event_ingestion_only"
    held_reviews: int | None = None
    publication: Literal["not_implemented"] = "not_implemented"


class EditionsResponse(BaseModel):
    status: Literal["not_implemented"] = "not_implemented"
    editions: list[dict[str, str]] = Field(default_factory=list)
