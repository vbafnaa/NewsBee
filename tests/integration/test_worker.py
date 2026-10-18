import threading
import time

import pytest

from projects.backend.modules.orchestration.worker import run
from projects.backend.shared.storage.database import connect, initialize, snapshot


def test_worker_persists_heartbeat_and_survives_restart(settings):
    initialize(settings.database)
    previous = 0
    for _ in range(2):
        stop = threading.Event()
        worker = threading.Thread(target=run, args=(settings, stop))
        worker.start()
        try:
            deadline = time.monotonic() + 5
            while True:
                beat, counts, _ = snapshot(settings.database)
                if beat is not None and beat > previous:
                    previous = beat
                    break
                if time.monotonic() >= deadline:
                    pytest.fail("Worker did not record a heartbeat")
                time.sleep(0.05)
            assert counts["completed"] == 0
        finally:
            stop.set()
            worker.join(timeout=5)
        assert not worker.is_alive()
    assert snapshot(settings.database)[0] is not None


def test_initialize_preserves_records(settings):
    initialize(settings.database)
    with connect(settings.database) as database:
        database.execute(
            "INSERT INTO jobs (id, kind, status, created_at) "
            "VALUES ('test', 'fixture', 'pending', 0)"
        )
    initialize(settings.database)
    assert snapshot(settings.database)[1]["pending"] == 1


def test_newer_schema_is_not_overwritten(settings):
    initialize(settings.database)
    with connect(settings.database) as database:
        database.execute("PRAGMA user_version = 99")
    with pytest.raises(RuntimeError, match="Unsupported database schema"):
        initialize(settings.database)
