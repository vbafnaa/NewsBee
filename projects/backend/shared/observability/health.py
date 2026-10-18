import asyncio
import logging
import smtplib
import sqlite3
import time

import httpx
from pydantic import ValidationError

from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.model_inference.ollama import ModelRuntime
from projects.backend.shared.storage.database import snapshot
from shared.contracts.health import ComponentHealth, HealthReport

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
    try:
        last_beat, counts, completed = await asyncio.to_thread(snapshot, settings.database)
        components["database"] = ComponentHealth(status="ok", detail="SQLite records readable")
        age = time.time() - last_beat if last_beat is not None else None
        fresh = age is not None and 0 <= age <= settings.heartbeat_max_age
        components["worker"] = ComponentHealth(
            status="ok" if fresh else "unavailable",
            detail=(
                f"Heartbeat age: {age:.1f}s; pipeline execution not implemented"
                if age is not None
                else "No worker heartbeat recorded"
            ),
        )
    except (sqlite3.Error, OSError) as error:
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
    return HealthReport(
        status="ok" if all(part.status == "ok" for part in components.values()) else "degraded",
        components=components,
        jobs=counts,
        last_completed_job_at=completed,
    )
