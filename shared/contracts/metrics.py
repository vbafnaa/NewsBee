from typing import Literal

from pydantic import BaseModel, Field


class DailyRuns(BaseModel):
    """Runs finished on one UTC day; `items` is events ingested or items published."""

    day: str
    completed: int = 0
    failed: int = 0
    items: int = 0


class SourceKindMetrics(BaseModel):
    """Per-source outcomes from each location's latest finished ingestion."""

    kind: Literal["library", "government"]
    sources: int = 0
    ingested: int = 0
    events: int = 0


class IngestionMetrics(BaseModel):
    runs: int = 0
    completed: int = 0
    failed: int = 0
    success_rate: float | None = None
    retried: int = 0
    median_duration_seconds: float | None = None
    p95_duration_seconds: float | None = None
    events: int = 0
    skipped_other_venues: int = 0
    skipped_outside_window: int = 0
    by_source: list[SourceKindMetrics] = Field(default_factory=list)
    daily: list[DailyRuns] = Field(default_factory=list)


class EditionMetrics(BaseModel):
    runs: int = 0
    completed: int = 0
    failed: int = 0
    publish_rate: float | None = None
    included: int = 0
    held: int = 0
    held_rate: float | None = None
    ranked: int = 0
    ranking_fallback_ratings: int = 0
    ranking_fallback_rate: float | None = None
    headline_fallbacks: int = 0
    median_duration_seconds: float | None = None
    daily: list[DailyRuns] = Field(default_factory=list)


class EmailMetrics(BaseModel):
    sent: int = 0
    pending: int = 0
    failed: int = 0
    delivery_rate: float | None = None


class QueueMetrics(BaseModel):
    pending: int = 0
    running: int = 0
    oldest_pending_age_seconds: float | None = None
    failed_last_24h: int = 0
    worker_heartbeat_age_seconds: float | None = None
    by_kind: dict[str, dict[str, int]] = Field(default_factory=dict)


class LocationFreshness(BaseModel):
    id: str
    name: str
    ingestion_status: str | None = None
    last_ingested_age_seconds: float | None = None
    last_published_age_seconds: float | None = None
    events: int | None = None
    sources: int = 0
    sources_ingested: int = 0
    government_platform: str | None = None


class MetricsReport(BaseModel):
    """Read-only operational metrics over the trailing window, for the review dashboard."""

    generated_at: float
    window_days: int
    ingestion: IngestionMetrics
    editions: EditionMetrics
    email: EmailMetrics
    queue: QueueMetrics
    locations: list[LocationFreshness] = Field(default_factory=list)
