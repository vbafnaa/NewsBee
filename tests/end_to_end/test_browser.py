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
    expect(page.get_by_role("status")).to_have_text("Overall: degraded")
    expect(page.locator("#services")).to_contain_text("ollama: not_configured")
    expect(page.locator("#services")).to_contain_text("worker: unavailable")
    page.get_by_role("button", name="Refresh health").click()
    expect(page.get_by_role("status")).to_have_text("Overall: degraded")


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
    expect(page.get_by_role("status")).to_have_text("Overall: degraded")
    page.route("**/api/health", lambda route: route.abort())
    page.get_by_role("button", name="Refresh health").click()
    expect(page.get_by_role("status")).to_contain_text("Health unavailable:")
    expect(page.locator("#services").locator("li")).to_have_count(0)
    expect(page.locator("#jobs")).to_have_text("Unavailable")
