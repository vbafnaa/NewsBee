import asyncio
import logging
import smtplib
import sqlite3
import time

import httpx
from pydantic import ValidationError

from projects.backend.modules.orchestration.jobs import latest_run
from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.model_inference.ollama import ModelRuntime
from projects.backend.shared.storage.database import snapshot
from shared.contracts.health import CapabilityReadiness, ComponentHealth, HealthReport

logger = logging.getLogger(__name__)


def check_mailpit(settings: Settings) -> ComponentHealth:
    with smtplib.SMTP(settings.mailpit_host, settings.mailpit_smtp_port, timeout=2) as smtp:
        code, _ = smtp.noop()
        if code != 250:
            raise smtplib.SMTPResponseException(code, b"SMTP health check failed")
    return ComponentHealth(status="ok", detail="Local SMTP sink is reachable; no email sent")


async def collect_health(settings: Settings, model: ModelRuntime) -> HealthReport:
    components = {"api": ComponentHealth(status="ok", detail="Local API is responding")}
    counts = None
    completed = None
    latest = None
    try:
        last_beat, counts, completed = await asyncio.to_thread(snapshot, settings.database)
        latest = await asyncio.to_thread(latest_run, settings.database)
        components["database"] = ComponentHealth(status="ok", detail="SQLite records readable")
        age = time.time() - last_beat if last_beat is not None else None
        fresh = age is not None and 0 <= age <= settings.heartbeat_max_age
        components["worker"] = ComponentHealth(
            status="ok" if fresh else "unavailable",
            detail=(
                f"Heartbeat age: {age:.1f}s; local event ingestion only"
                if age is not None
                else "No worker heartbeat recorded"
            ),
        )
    except (sqlite3.Error, OSError) as error:
        counts = None
        completed = None
        latest = None
        logger.warning("Database health check failed: %s", error)
        components["database"] = ComponentHealth(status="unavailable", detail=str(error))
        components["worker"] = ComponentHealth(
            status="unavailable", detail="Cannot inspect heartbeat without database access"
        )
    try:
        components["ollama"] = await model.health()
    except (httpx.HTTPError, ValueError, KeyError, TypeError, ValidationError) as error:
        detail = f"Ollama at {settings.ollama_url}: {type(error).__name__}: {error}"
        logger.warning("Ollama health check failed: %s", detail)
        components["ollama"] = ComponentHealth(status="unavailable", detail=detail)
    try:
        components["mailpit"] = await asyncio.to_thread(check_mailpit, settings)
    except (OSError, smtplib.SMTPException) as error:
        logger.warning("Mailpit health check failed: %s", error)
        components["mailpit"] = ComponentHealth(status="unavailable", detail=str(error))
    ingestion_ready = all(components[name].status == "ok" for name in ("api", "database", "worker"))
    model_status = components["ollama"].status
    capabilities = {
        "ingestion": CapabilityReadiness(
            status="ready" if ingestion_ready else "unavailable",
            detail="Local ingestion infrastructure only; source access and outcomes are separate.",
        ),
        "ai": CapabilityReadiness(
            status="ready" if model_status == "ok" else model_status,
            detail="Model-runtime availability only; story generation is not implemented.",
        ),
        "email_sink": CapabilityReadiness(
            status="ready" if components["mailpit"].status == "ok" else "unavailable",
            detail="Local SMTP connectivity only; email composition is not implemented.",
        ),
        "publishing": CapabilityReadiness(
            status="not_implemented",
            detail="No editorial approval or publishing workflow exists.",
        ),
    }
    return HealthReport(
        status="ok" if all(part.status == "ok" for part in components.values()) else "degraded",
        components=components,
        capabilities=capabilities,
        latest_ingestion=latest,
        jobs=counts,
        last_completed_job_at=completed,
    )
