import asyncio
import logging
import signal
import threading
from concurrent.futures import ThreadPoolExecutor

import httpx

from projects.backend.modules.editions import drafting
from projects.backend.modules.orchestration import jobs
from projects.backend.modules.source_connectors.pipelines.events import ingest
from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.observability.logging import configure_logging
from projects.backend.shared.storage.database import heartbeat, initialize

logger = logging.getLogger(__name__)


def execute_ingestion(settings: Settings, job: dict) -> None:
    try:
        with httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as client:
            ingest(settings, job, client)
    except (httpx.HTTPError, ValueError, OSError) as error:
        retryable = isinstance(error, httpx.TransportError) or (
            isinstance(error, httpx.HTTPStatusError)
            and (error.response.status_code == 429 or error.response.status_code >= 500)
        )
        jobs.fail(settings.database, job, error, retryable)


def execute_authoring(settings: Settings, job: dict) -> None:
    try:
        run = asyncio.run(drafting.author_edition(settings, job["source_id"]))
    except drafting.ModelNotReady as error:
        jobs.fail(settings.database, job, error, retryable=True)
        return
    except Exception as error:
        jobs.fail(settings.database, job, error, retryable=False)
        return
    jobs.complete(
        settings.database,
        job,
        {"edition_id": run.id, "snapshot_id": run.snapshot_id, "included": run.included},
    )


def execute(settings: Settings, job: dict) -> None:
    if job["kind"] == jobs.AUTHOR_KIND:
        execute_authoring(settings, job)
    else:
        execute_ingestion(settings, job)


def run(settings: Settings, stop: threading.Event) -> None:
    initialize(settings.database)
    logger.info("Worker starting; local ingestion and automatic edition publishing enabled")
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = None
        job = None
        while not stop.is_set():
            heartbeat(settings.database)
            if future is not None:
                if future.done():
                    future.result()
                    future = None
                else:
                    jobs.renew(settings.database, job)
            if future is None:
                job = jobs.claim(settings.database)
                if job:
                    future = executor.submit(execute, settings, job)
            stop.wait(settings.heartbeat_interval)
        if future is not None:
            future.result()
    logger.info("Worker stopped")


def main() -> None:
    configure_logging()
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    run(Settings(), stop)


if __name__ == "__main__":
    main()
