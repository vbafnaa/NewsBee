import httpx

from shared.contracts.health import ComponentHealth


def test_failed_dependency_checks_are_visible(client, model, monkeypatch):
    async def fail_model():
        raise httpx.ConnectError("Ollama fixture unavailable")

    def fail_mail(_):
        raise ConnectionRefusedError("Mailpit fixture unavailable")

    monkeypatch.setattr(model, "health", fail_model)
    monkeypatch.setattr("projects.backend.shared.observability.health.check_mailpit", fail_mail)
    response = client.get("/api/health")
    assert response.status_code == 503
    for name in ("ollama", "mailpit"):
        assert response.json()["components"][name]["status"] == "unavailable"


def test_healthy_dependencies_do_not_claim_editorial_readiness(
    client, settings, model, monkeypatch
):
    from projects.backend.shared.storage.database import heartbeat

    async def ready():
        return ComponentHealth(status="ok", detail="Fixture model")

    monkeypatch.setattr(model, "health", ready)
    heartbeat(settings.database)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["pipelines"] == "local_event_ingestion_only"


def test_ingestion_ready_without_model_or_mailpit(client, settings, monkeypatch):
    from projects.backend.shared.storage.database import heartbeat

    def unavailable(_):
        raise ConnectionRefusedError("SMTP offline")

    monkeypatch.setattr("projects.backend.shared.observability.health.check_mailpit", unavailable)
    heartbeat(settings.database)
    response = client.get("/api/health")
    assert response.status_code == 503  # All-service readiness retains its existing contract.
    capabilities = response.json()["capabilities"]
    assert capabilities["ingestion"]["status"] == "ready"
    assert capabilities["ai"]["status"] == "not_configured"
    assert capabilities["email_sink"]["status"] == "unavailable"
    assert capabilities["publishing"]["status"] == "not_implemented"


def test_latest_ingestion_does_not_erase_failure_history(client, settings):
    from projects.backend.shared.storage.database import connect, heartbeat

    heartbeat(settings.database)
    with connect(settings.database) as database:
        for identity, status, created, error in (
            ("old", "failed", 1, "Parse failure"),
            ("new", "completed", 2, None),
        ):
            database.execute(
                """INSERT INTO jobs (id, kind, source_id, status, created_at, attempts, error)
                VALUES (?, 'ingest_events', 'spl-capitol-hill', ?, ?, 1, ?)""",
                (identity, status, created, error),
            )
    report = client.get("/api/health").json()
    assert report["latest_ingestion"]["id"] == "new"
    assert report["latest_ingestion"]["status"] == "completed"
    assert report["jobs"]["failed"] == 1
    assert report["capabilities"]["ingestion"]["status"] == "ready"
    with connect(settings.database) as database:
        database.execute(
            "UPDATE jobs SET status = 'failed', error = 'Current failure' WHERE id='new'"
        )
    report = client.get("/api/health").json()
    assert report["latest_ingestion"]["error"] == "Current failure"
    assert report["jobs"]["failed"] == 2


def test_no_runs_and_database_failure_are_distinct(client, monkeypatch):
    import sqlite3

    report = client.get("/api/health").json()
    assert report["latest_ingestion"] is None
    assert report["jobs"] is not None

    def unavailable(_):
        raise sqlite3.OperationalError("Cannot read runs")

    monkeypatch.setattr("projects.backend.shared.observability.health.latest_run", unavailable)
    report = client.get("/api/health").json()
    assert report["latest_ingestion"] is None
    assert report["jobs"] is None
    assert report["capabilities"]["ingestion"]["status"] == "unavailable"
