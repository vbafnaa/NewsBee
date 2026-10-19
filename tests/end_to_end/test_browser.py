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
        route.fulfill(
            response=page.request.fetch(
                f"{api_url}{path}",
                method=route.request.method,
                data=route.request.post_data,
                headers={"Content-Type": "application/json"},
            )
        )

    page.route("http://127.0.0.1:8000/api/**", forward)


@pytest.fixture
def reader_directory(settings):
    from projects.backend.modules.communities import directory
    from tests.unit.test_communities import archive

    directory.build(archive(), directory.directory_path(settings.data_dir))


def test_reader_selects_location_and_reads_published_edition(
    page, api_url, website_url, settings, ingested_event, monkeypatch, reader_directory
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
    search = page.get_by_role("combobox", name="Find your local edition")
    expect(search).to_have_value("Bainbridge Island, WA")
    expect(page.get_by_role("status")).to_have_text("No edition yet.")
    expect(page.get_by_role("article", name="Edition")).to_be_hidden()
    search.fill("Sea")
    page.get_by_role("option", name="Seattle, WA", exact=True).click()
    edition = page.get_by_role("article", name="Edition")
    expect(edition.get_by_role("heading", level=2)).to_have_text(
        f"{ingested_event['events'][0]['facts']['title']} this week"
    )
    title = ingested_event["events"][0]["facts"]["title"]
    expect(edition.get_by_role("heading", level=3, name=title)).to_be_visible()
    expect(edition.get_by_role("link", name="Original event")).to_have_attribute(
        "href", ingested_event["events"][0]["facts"]["source_url"]
    )
    expect(edition).to_contain_text("Events from 2026-11-01 to 2026-11-07.")
    assert page.url.endswith("?location=seattle-wa")

    page.goto(f"{website_url}/?location=seattle-wa")
    expect(search).to_have_value("Seattle, WA")
    expect(page.get_by_role("heading", level=3, name=title)).to_be_visible()
    page.goto(f"{website_url}/?location=unknown")
    expect(page.locator("#edition-status")).to_contain_text("Location unavailable:")
    expect(search).to_have_value("")


def test_reader_without_locations_can_search_and_sign_up(
    page, api_url, website_url, reader_directory, settings
):
    from projects.backend.shared.storage.database import connect

    forward_api(page, api_url)
    page.goto(website_url)
    search = page.get_by_role("combobox", name="Find your local edition")
    expect(search).to_be_enabled()
    search.fill("Sea, OR")
    expect(page.get_by_role("option", name="Seaside, OR")).to_be_visible()
    search.press("ArrowDown")
    expect(search).to_have_attribute("aria-activedescendant", "location-option-0")
    search.press("Enter")
    expect(search).to_have_value("Seaside, OR")
    expect(search).to_have_attribute("aria-expanded", "false")
    expect(
        page.get_by_role("heading", name="We're not in Seaside yet. Let's change that.")
    ).to_be_visible()
    expect(page.get_by_role("article", name="Edition")).to_be_hidden()
    assert page.url.endswith("?location=seaside-or")
    page.get_by_label("Your email").fill("reader@example.com")
    page.get_by_role("button", name="Help bring Newsbee here").click()
    expect(page.locator("#signup-status")).to_contain_text(
        "You're on the interest list for Seaside, OR"
    )
    with connect(settings.database) as database:
        [row] = database.execute("SELECT * FROM expansion_signups").fetchall()
        assert (row["location_id"], row["email"]) == ("seaside-or", "reader@example.com")
    page.reload()
    expect(search).to_have_value("Seaside, OR")
    expect(page.locator("#expansion")).to_be_visible()
    search.fill("zzzz")
    expect(page.locator("#location-help")).to_contain_text("No matching towns")
    expect(page.get_by_role("listbox")).to_be_hidden()


def test_reader_switches_from_edition_to_expansion_and_back(
    page, api_url, website_url, reader_directory, settings, ingested_event, monkeypatch
):
    from tests.integration.test_edition_publishing import run_worker

    run_worker(settings, monkeypatch)
    forward_api(page, api_url)
    page.goto(f"{website_url}/?location=seattle-wa")
    edition = page.get_by_role("article", name="Edition")
    expect(edition).to_be_visible()
    search = page.get_by_role("combobox", name="Find your local edition")
    search.fill("Sea")
    page.get_by_role("option", name="Seaside, OR").click()
    expect(edition).to_be_hidden()
    expect(page.locator("#expansion")).to_be_visible()
    search.fill("Seattle")
    page.get_by_role("option", name="Seattle, WA").click()
    expect(edition).to_be_visible()
    expect(page.locator("#expansion")).to_be_hidden()


def test_reader_search_failure_and_escape(page, api_url, website_url, reader_directory):
    forward_api(page, api_url)
    page.goto(website_url)
    search = page.get_by_role("combobox", name="Find your local edition")
    search.fill("Sea")
    expect(page.get_by_role("option", name="Seattle, WA")).to_be_visible()
    search.press("ArrowDown")
    search.press("Escape")
    expect(search).to_have_attribute("aria-expanded", "false")
    expect(search).not_to_have_attribute("aria-activedescendant")
    page.route("**/api/locations/search?*", lambda route: route.abort())
    search.fill("Seattle")
    expect(page.locator("#location-help")).to_contain_text("Location search unavailable:")
    expect(page.locator("#expansion")).to_be_hidden()


def test_reader_signup_failure_is_not_success(page, api_url, website_url, reader_directory):
    forward_api(page, api_url)
    page.goto(f"{website_url}/?location=seaside-or")
    page.route("**/api/locations/seaside-or/interest", lambda route: route.abort())
    page.get_by_label("Your email").fill("reader@example.com")
    button = page.get_by_role("button", name="Help bring Newsbee here")
    button.click()
    expect(page.locator("#signup-status")).to_contain_text("Signup unavailable:")
    expect(button).to_be_enabled()
    expect(page.get_by_label("Your email")).to_have_value("reader@example.com")


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
