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
    assert response.json()["pipelines"] == "not_implemented"
