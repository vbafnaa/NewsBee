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
from tests import library_world

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


def forward_api(page, api_url):
    def forward(route):
        path = route.request.url.removeprefix("http://127.0.0.1:8000")
        route.fulfill(response=page.request.get(f"{api_url}{path}"))

    page.route("http://127.0.0.1:8000/api/**", forward)


@pytest.mark.critical
def test_reader_selects_location_and_reads_published_edition(
    page, api_url, website_url, settings, ingested_event, monkeypatch
):
    from projects.backend.modules.communities import locations
    from tests.integration.test_edition_publishing import run_worker

    run_worker(settings, monkeypatch)
    other = {
        **library_world.profile(),
        "id": "bainbridge-island-wa",
        "name": "Bainbridge Island, WA",
    }
    locations.save(settings.database, other)
    forward_api(page, api_url)
    page.goto(website_url)
    select = page.get_by_label("Location")
    expect(select).to_have_value("bainbridge-island-wa")
    expect(page.get_by_role("status")).to_have_text("No edition yet.")
    expect(page.get_by_role("article", name="Edition")).to_be_hidden()
    select.select_option(label="Seattle, WA")
    edition = page.get_by_role("article", name="Edition")
    expect(edition.get_by_role("heading", level=2)).to_have_text(
        f"{ingested_event['events'][0]['facts']['title']} this week"
    )
    title = ingested_event["events"][0]["facts"]["title"]
    expect(edition.get_by_role("heading", level=3, name=title)).to_be_visible()
    expect(edition.get_by_role("link", name="Original source")).to_have_attribute(
        "href", ingested_event["events"][0]["facts"]["source_url"]
    )
    expect(edition).to_contain_text("Upcoming listings: 2026-11-01 to 2026-11-07.")
    expect(edition).to_contain_text("Source: Example City Library")
    edition.get_by_text("About this edition and its sources").click()
    expect(edition).to_contain_text("coverage unavailable (unresolved_website)")
    assert page.url.endswith("?location=seattle-wa")
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")

    page.goto(f"{website_url}/?location=seattle-wa")
    expect(page.get_by_label("Location")).to_have_value("seattle-wa")
    expect(page.get_by_role("heading", level=3, name=title)).to_be_visible()
    page.goto(f"{website_url}/?location=unknown")
    expect(page.get_by_label("Location")).to_have_value("bainbridge-island-wa")
    from projects.backend.modules.editions import drafting
    from projects.backend.modules.editorial.corrections import withdrawals

    published = drafting.latest_published(settings.database, library_world.LOCATION_ID)
    withdrawals.withdraw(
        settings.database,
        published.id,
        published.items[0].story_id,
        "The source listing was incorrect; the story has been withdrawn.",
    )
    page.goto(f"{website_url}/?location=seattle-wa")
    expect(page.get_by_label("Corrections")).to_contain_text("The source listing was incorrect")
    expect(page.locator(".story")).to_have_count(0)
    expect(page.locator("#edition-intro")).to_contain_text("does not mean nothing is happening")


@pytest.mark.critical
def test_reader_without_locations(page, api_url, website_url):
    forward_api(page, api_url)
    page.goto(website_url)
    expect(page.get_by_role("status")).to_have_text("No locations onboarded yet.")
    expect(page.get_by_label("Location")).to_be_disabled()


@pytest.mark.critical
def test_reader_reports_api_failure(page, website_url):
    page.route("http://127.0.0.1:8000/api/editions", lambda route: route.abort())
    page.goto(website_url)
    expect(page.get_by_role("status")).to_contain_text("Editions unavailable:")
    page.route(
        "http://127.0.0.1:8000/api/editions",
        lambda route: route.fulfill(json={"locations": []}),
    )
    page.get_by_role("button", name="Try again").click()
    expect(page.get_by_role("status")).to_have_text("No locations onboarded yet.")


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
    expect(page.locator("#latest-edition")).to_have_text("Latest edition unavailable")


def test_ingestion_ready_without_model_and_old_failure_visible(page, api_url, settings):
    from projects.backend.shared.storage.database import connect, heartbeat

    heartbeat(settings.database)
    with connect(settings.database) as database:
        database.execute(
            """INSERT INTO jobs
            (id, kind, source_id, status, created_at, attempts, error)
            VALUES ('old-failure', 'ingest_events', 'seattle-wa', 'failed', 1, 1,
            'Historical parsing failure')"""
        )
        database.execute(
            """INSERT INTO jobs
            (id, kind, source_id, status, created_at, attempts, result_json)
            VALUES ('latest-success', 'ingest_events', 'seattle-wa', 'completed', 2, 1,
            '{"event_count":23,"skipped_outside_window":7,"duration_seconds":0.3}')"""
        )
    page.goto(f"{api_url}/review")
    expect(page.get_by_role("status")).to_have_text(
        "Ingestion: ready. All-service health: degraded."
    )
    expect(page.locator("#capabilities")).to_contain_text("ai: not_configured")
    expect(page.locator("#capabilities")).to_contain_text("publishing: ready")
    expect(page.locator("#latest-ingestion")).to_contain_text("seattle-wa: completed")
    expect(page.locator("#latest-ingestion")).to_contain_text("events: 23")
    expect(page.locator("#latest-ingestion")).to_contain_text("outside 7-day window: 7")
    expect(page.locator("#jobs")).to_contain_text("failed: 1")


def test_inspection_navigation_and_retained_pipeline_facts(page, api_url, ingested_event):
    page.goto(f"{api_url}/review")
    expect(page.locator("#locations")).to_contain_text(
        "Seattle, WA: 1/2 websites resolved; latest ingestion completed"
    )
    expect(page.locator("#locations")).to_contain_text("Example County Library: unresolved_website")
    page.get_by_role("link", name="Inspect retained events and ingestion jobs").click()
    expect(page.get_by_role("heading", name="Ingestion inspection", exact=True)).to_be_visible()
    expect(
        page.get_by_role("heading", name=ingested_event["events"][0]["facts"]["title"])
    ).to_be_visible()
    expect(page.get_by_role("link", name="View original event")).to_have_attribute(
        "href", ingested_event["events"][0]["facts"]["source_url"]
    )
    expect(page.locator("main")).to_contain_text(ingested_event["events"][0]["retrieved_at"])
    expect(page.get_by_role("heading", name="seattle-wa: completed")).to_be_visible()
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


def test_published_edition_audit_from_health(page, api_url, settings, ingested_event, monkeypatch):
    from tests.integration.test_edition_publishing import run_worker

    run_worker(settings, monkeypatch)
    page.goto(f"{api_url}/review")
    expect(page.locator("#latest-edition")).to_contain_text(
        "seattle-wa, 2026-11-01 to 2026-11-07: completed"
    )
    expect(page.locator("#latest-edition")).to_contain_text(
        "included: 1; held: 0; attempted: 1; stories: 1; headline: model"
    )
    expect(page.locator("#locations")).to_contain_text("edition published")
    expect(page.locator("#kpis")).to_contain_text("100% of 1 runs")
    expect(page.locator("#kpis")).to_contain_text("Ingestion success100%")
    expect(page.locator("#location-table")).to_contain_text("Seattle, WA")
    expect(page.locator("#sources")).to_contain_text("Libraries")
    expect(page.get_by_role("img", name="Edition runs: 1 over 7 days")).to_be_visible()
    page.get_by_label("Window").select_option("30")
    expect(page.get_by_role("img", name="Edition runs: 1 over 30 days")).to_be_visible()
    page.route("**/api/metrics*", lambda route: route.abort())
    page.get_by_role("button", name="Refresh health").click()
    expect(page.get_by_role("alert")).to_contain_text("Metrics unavailable:")
    expect(page.locator("#kpis")).to_be_empty()
    expect(page.locator("#latest-edition")).to_contain_text("completed")
    page.unroute("**/api/metrics*")
    page.reload()
    page.get_by_role("link", name="Audit the latest edition run and held items").click()
    edition = page.get_by_role("article", name="Latest edition")
    expect(edition.get_by_role("heading", level=1)).to_contain_text(" this week")
    expect(
        edition.get_by_role("heading", level=2, name=ingested_event["events"][0]["facts"]["title"])
    ).to_be_visible()
    expect(edition.get_by_role("link", name="View original event")).to_be_visible()
    expect(page.locator("main")).to_contain_text("No held items.")
