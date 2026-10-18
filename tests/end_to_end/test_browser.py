import functools
import http.server
import shutil
import socket
import subprocess
import threading
import time

import pytest
import uvicorn
from playwright.sync_api import expect

from projects.backend.shared.configuration.settings import ROOT

pytestmark = pytest.mark.browser


@pytest.fixture
def api_url(app):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_config=None))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started:
                if not thread.is_alive() or time.monotonic() > deadline:
                    pytest.fail("Test API did not start")
                time.sleep(0.05)
            yield f"http://127.0.0.1:{port}"
        finally:
            server.should_exit = True
            thread.join(timeout=10)


@pytest.fixture(scope="module")
def website_url():
    npm = shutil.which("npm")
    if not npm:
        pytest.fail("npm required; run local setup first")
    website = ROOT / "projects" / "website"
    subprocess.run([npm, "run", "build"], cwd=website, check=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=website / "dist")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_review_displays_real_health_report(page, api_url):
    page.goto(f"{api_url}/review")
    expect(page.get_by_role("heading", name="Newsbee local health")).to_be_visible()
    expect(page.get_by_role("status")).to_have_text(
        "Ingestion: unavailable. All-service health: degraded."
    )
    expect(page.locator("#services")).to_contain_text("ollama: not_configured")
    expect(page.locator("#services")).to_contain_text("worker: unavailable")
    page.get_by_role("button", name="Refresh health").click()
    expect(page.get_by_role("status")).to_contain_text("Ingestion: unavailable.")


def test_reader_consumes_editions_api(page, api_url, website_url):
    def forward(route):
        response = page.request.get(f"{api_url}/api/editions")
        route.fulfill(response=response)

    page.route("http://127.0.0.1:8000/api/editions", forward)
    page.goto(website_url)
    expect(page.get_by_role("status")).to_have_text(
        "No editions yet. Publishing is not implemented."
    )


def test_reader_reports_api_failure(page, website_url):
    page.route("http://127.0.0.1:8000/api/editions", lambda route: route.abort())
    page.goto(website_url)
    expect(page.get_by_role("status")).to_contain_text("Editions unavailable:")


def test_review_clears_stale_health_on_api_failure(page, api_url):
    page.goto(f"{api_url}/review")
    expect(page.get_by_role("status")).to_contain_text("Ingestion: unavailable.")
    page.route("**/api/health", lambda route: route.abort())
    page.get_by_role("button", name="Refresh health").click()
    expect(page.get_by_role("status")).to_contain_text("Health unavailable:")
    expect(page.locator("#services").locator("li")).to_have_count(0)
    expect(page.locator("#jobs")).to_have_text("Unavailable")
    expect(page.locator("#capabilities").locator("li")).to_have_count(0)
    expect(page.locator("#latest-ingestion")).to_have_text("Latest ingestion unavailable")


def test_ingestion_ready_without_model_and_old_failure_visible(page, api_url, settings):
    from projects.backend.shared.storage.database import connect, heartbeat

    heartbeat(settings.database)
    with connect(settings.database) as database:
        database.execute(
            """INSERT INTO jobs
            (id, kind, source_id, status, created_at, attempts, error)
            VALUES ('old-failure', 'ingest_events', 'spl-capitol-hill', 'failed', 1, 1,
            'Historical parsing failure')"""
        )
        database.execute(
            """INSERT INTO jobs
            (id, kind, source_id, status, created_at, attempts, result_json)
            VALUES ('latest-success', 'ingest_events', 'spl-capitol-hill', 'completed', 2, 1,
            '{"event_count":23,"skipped_library_closures":7,"duration_seconds":0.3}')"""
        )
    page.goto(f"{api_url}/review")
    expect(page.get_by_role("status")).to_have_text(
        "Ingestion: ready. All-service health: degraded."
    )
    expect(page.locator("#capabilities")).to_contain_text("ai: not_configured")
    expect(page.locator("#capabilities")).to_contain_text("publishing: not_implemented")
    expect(page.locator("#latest-ingestion")).to_contain_text("spl-capitol-hill: completed")
    expect(page.locator("#latest-ingestion")).to_contain_text("events: 23")
    expect(page.locator("#latest-ingestion")).to_contain_text("closures skipped: 7")
    expect(page.locator("#jobs")).to_contain_text("failed: 1")


def test_inspection_navigation_and_retained_pipeline_facts(page, api_url, ingested_event):
    page.goto(f"{api_url}/review")
    page.get_by_role("link", name="Inspect retained events and ingestion jobs").click()
    expect(page.get_by_role("heading", name="Ingestion inspection", exact=True)).to_be_visible()
    expect(
        page.get_by_role("heading", name=ingested_event["events"][0]["facts"]["title"])
    ).to_be_visible()
    expect(page.get_by_role("link", name="View original event")).to_have_attribute(
        "href", ingested_event["events"][0]["facts"]["source_url"]
    )
    expect(page.locator("main")).to_contain_text(ingested_event["events"][0]["retrieved_at"])
    expect(page.get_by_role("heading", name="spl-capitol-hill: completed")).to_be_visible()
    page.get_by_role("link", name="Refresh inspection").click()
    expect(page.locator("main")).to_contain_text("1 events shown")
    page.get_by_role("link", name="Local health").click()
    expect(page.get_by_role("heading", name="Newsbee local health")).to_be_visible()


def test_empty_inspection_in_browser(page, api_url):
    page.goto(f"{api_url}/review/ingestion")
    expect(page.locator("main")).to_contain_text("No retained events yet.")
    expect(page.locator("main")).to_contain_text("No ingestion jobs yet.")


def test_inspection_storage_failure_in_browser(page, api_url, monkeypatch):
    import sqlite3

    def fail(_):
        raise sqlite3.OperationalError("fixture outage")

    monkeypatch.setattr("projects.backend.api.routes.console.inspect", fail)
    response = page.goto(f"{api_url}/review/ingestion")
    assert response.status == 503
    expect(page.get_by_role("alert")).to_contain_text("Ingestion inspection unavailable.")
