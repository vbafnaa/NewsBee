import json
import sqlite3
import time

import pytest

from projects.backend.shared.storage.database import SCHEMA_VERSION, connect, heartbeat
from shared.contracts.health import Edition, EditionsResponse, HealthReport
from shared.contracts.metrics import MetricsReport


@pytest.mark.critical
def test_startup_initializes_local_storage(client, settings):
    assert client.get("/api/live").json() == {"status": "ok"}
    assert settings.database.is_file()
    assert settings.evidence_dir.is_dir()
    with connect(settings.database) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION


@pytest.mark.critical
def test_editions_list_onboarded_locations_without_editions(client, settings):
    from tests import library_world

    assert client.get("/api/editions").json() == EditionsResponse().model_dump()
    library_world.onboard(settings.database)
    listing = client.get("/api/editions").json()["locations"]
    assert listing == [
        {
            "location_id": "seattle-wa",
            "location_name": "Seattle, WA",
            "edition_id": None,
            "published_at": None,
            "window_start": None,
            "window_end": None,
        }
    ]
    assert client.get("/api/editions/seattle-wa").json() == {"detail": "No edition yet"}
    assert client.get("/api/editions/seattle-wa").status_code == 404
    assert client.get("/api/editions/nowhere-xx").json() == {
        "detail": "Unknown location: nowhere-xx"
    }


@pytest.mark.critical
def test_editions_storage_failure_is_503(client, monkeypatch):
    def fail(_):
        raise sqlite3.OperationalError("fixture outage")

    monkeypatch.setattr("projects.backend.modules.editions.drafting.listings", fail)
    assert client.get("/api/editions").status_code == 503


def test_missing_worker_and_unselected_model_are_not_green(client):
    response = client.get("/api/health")
    assert response.status_code == 503
    report = HealthReport.model_validate(response.json())
    assert report.status == "degraded"
    assert report.components["worker"].status == "unavailable"
    assert report.components["ollama"].status == "not_configured"
    assert report.jobs == {"pending": 0, "running": 0, "failed": 0, "completed": 0}
    assert report.publication == "automatic_local_only"
    assert report.latest_edition is None


def test_worker_heartbeat_and_staleness(client, settings):
    heartbeat(settings.database)
    assert client.get("/api/health").json()["components"]["worker"]["status"] == "ok"
    with connect(settings.database) as database:
        database.execute("UPDATE worker_heartbeat SET updated_at = ?", (time.time() - 60,))
    assert client.get("/api/health").json()["components"]["worker"]["status"] == "unavailable"


def test_database_failure_is_explicit(client, monkeypatch):
    def fail(_):
        raise sqlite3.OperationalError("fixture database failure")

    monkeypatch.setattr("projects.backend.shared.observability.health.snapshot", fail)
    report = client.get("/api/health").json()
    assert report["components"]["database"]["status"] == "unavailable"
    assert report["jobs"] is None


def test_review_page_and_static_assets(client):
    assert "Newsbee local health" in client.get("/review").text
    assert client.get("/review/static/health.js").status_code == 200
    assert client.get("/review/static/style.css").status_code == 200


def test_cors_allows_only_local_website(client):
    allowed = client.get("/api/editions", headers={"Origin": "http://127.0.0.1:4321"})
    assert allowed.headers["access-control-allow-origin"] == "http://127.0.0.1:4321"
    denied = client.get("/api/editions", headers={"Origin": "https://example.com"})
    assert "access-control-allow-origin" not in denied.headers


@pytest.mark.critical
def test_generated_contracts_match_models():
    from projects.backend.shared.configuration.settings import ROOT

    for name, model in (
        ("health", HealthReport),
        ("editions", EditionsResponse),
        ("edition", Edition),
        ("metrics", MetricsReport),
    ):
        schema = ROOT / "shared" / "contracts" / f"{name}.schema.json"
        assert json.loads(schema.read_text(encoding="utf-8")) == model.model_json_schema()


def test_metrics_empty_and_storage_failure(client, monkeypatch):
    report = MetricsReport.model_validate(client.get("/api/metrics").json())
    assert report.window_days == 7
    assert report.ingestion.runs == 0 and report.ingestion.success_rate is None
    assert len(report.ingestion.daily) == 7
    assert report.locations == []
    assert client.get("/api/metrics?days=0").status_code == 422

    def fail(*_, **__):
        raise sqlite3.OperationalError("fixture outage")

    monkeypatch.setattr("projects.backend.api.routes.infrastructure.collect_metrics", fail)
    assert client.get("/api/metrics").status_code == 503
