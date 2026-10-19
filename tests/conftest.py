from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from projects.backend.api.app import create_app
from projects.backend.api.dependencies.services import get_model
from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.model_inference.ollama import ModelUnavailableError
from shared.contracts.health import ComponentHealth


@pytest.fixture
def settings(tmp_path: Path, monkeypatch) -> Settings:
    for name in Settings.model_fields:
        monkeypatch.delenv(f"NEWSBEE_{name.upper()}", raising=False)
    return Settings(data_dir=tmp_path / "data")


@pytest.fixture
def model():
    class FakeModel:
        async def health(self) -> ComponentHealth:
            return ComponentHealth(status="not_configured", detail="No test model selected")

        async def generate(self, prompt: str) -> str:
            raise ModelUnavailableError("No test model selected")

    return FakeModel()


@pytest.fixture
def app(settings, model, monkeypatch):
    monkeypatch.setattr(
        "projects.backend.shared.observability.health.check_mailpit",
        lambda _: ComponentHealth(status="ok", detail="Test SMTP fixture"),
    )
    application = create_app(settings)
    application.dependency_overrides[get_model] = lambda: model
    return application


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        yield client


@pytest.fixture
def ingested_event(settings):
    from projects.backend.modules.orchestration import jobs
    from projects.backend.modules.source_connectors.pipelines.events import ingest
    from projects.backend.shared.configuration.settings import ROOT
    from projects.backend.shared.storage.database import initialize

    initialize(settings.database)
    jobs.enqueue(settings.database, "spl-capitol-hill")
    job = jobs.claim(settings.database)
    feed = (ROOT / "tests" / "fixtures" / "library_events.xml").read_bytes()
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=feed))
    ) as transport:
        ingest(settings, job, transport)
    return jobs.inspect(settings.database)
