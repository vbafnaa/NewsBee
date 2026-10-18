import logging
import signal
import threading

from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.observability.logging import configure_logging
from projects.backend.shared.storage.database import heartbeat, initialize

logger = logging.getLogger(__name__)


def run(settings: Settings, stop: threading.Event) -> None:
    initialize(settings.database)
    logger.info("Worker starting; heartbeat enabled, pipeline execution not implemented")
    while not stop.is_set():
        heartbeat(settings.database)
        logger.info("Worker heartbeat recorded")
        stop.wait(settings.heartbeat_interval)
    logger.info("Worker stopped")


def main() -> None:
    configure_logging()
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    run(Settings(), stop)


if __name__ == "__main__":
    main()
