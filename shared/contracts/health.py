from typing import Literal

from pydantic import BaseModel, Field


class ComponentHealth(BaseModel):
    status: Literal["ok", "unavailable", "not_configured"]
    detail: str


class CapabilityReadiness(BaseModel):
    status: Literal["ready", "unavailable", "not_configured", "not_implemented"]
    detail: str


class SystemIngestion(BaseModel):
    source_id: str
    name: str
    status: Literal["ingested", "no_feed", "unresolved_website", "blocked", "failed"]
    detail: str
    feed_kind: str | None = None
    event_count: int = 0
    skipped_other_venues: int = 0


class IngestionRun(BaseModel):
    id: str
    location_id: str
    status: Literal["pending", "running", "failed", "completed"]
    attempts: int
    error: str | None
    event_count: int | None = None
    skipped_other_venues: int | None = None
    skipped_outside_window: int | None = None
    duration_seconds: float | None = None
    systems: list[SystemIngestion] | None = None


class LocationStatus(BaseModel):
    id: str
    name: str
    library_systems: int
    websites_resolved: int
    latest_ingestion: IngestionRun | None = None
    latest_edition_id: str | None = None
    latest_edition_published_at: float | None = None


class EditionRun(BaseModel):
    """One authoring run over one location snapshot. A completed run is the published edition."""

    id: str
    community_id: str
    snapshot_id: str | None = None
    window_start: str
    window_end: str
    model: str
    status: Literal["running", "failed", "completed"]
    error: str | None
    included: int | None = None
    held: int | None = None
    attempted: int | None = None
    not_attempted: int | None = None
    events: int | None = None
    stories: int | None = None
    skipped_for_variety: int | None = None
    ranked: int | None = None
    ranking_fallback_ratings: int | None = None
    duration_seconds: float | None = None
    front_fallback: bool | None = None
    email_fallback: bool | None = None


class EmailDelivery(BaseModel):
    """Email-preview delivery for one location's most recently emailed edition."""

    edition_id: str
    location_id: str
    sent: int = 0
    pending: int = 0
    failed: int = 0
    errors: list[str] = Field(default_factory=list)


class HealthReport(BaseModel):
    status: Literal["ok", "degraded"]
    components: dict[str, ComponentHealth]
    capabilities: dict[str, CapabilityReadiness]
    latest_ingestion: IngestionRun | None = None
    locations: list[LocationStatus] | None = None
    latest_edition: EditionRun | None = None
    email_deliveries: list[EmailDelivery] | None = None
    jobs: dict[str, int] | None = None
    last_completed_job_at: float | None = None
    pipelines: Literal["local_ingestion_and_auto_publish"] = "local_ingestion_and_auto_publish"
    publication: Literal["automatic_local_only"] = "automatic_local_only"


class EditionItem(BaseModel):
    headline: str
    blurb: str
    when_where: str
    event_date: str
    source_url: str | None
    rank: int | None = None


class Edition(BaseModel):
    id: str
    location_id: str
    location_name: str
    window_start: str
    window_end: str
    published_at: float
    headline: str
    intro: str
    items: list[EditionItem]


class EditionListing(BaseModel):
    location_id: str
    location_name: str
    edition_id: str | None = None
    published_at: float | None = None
    window_start: str | None = None
    window_end: str | None = None


class EditionsResponse(BaseModel):
    usage: Literal["local_evaluation_only"] = "local_evaluation_only"
    locations: list[EditionListing] = Field(default_factory=list)
