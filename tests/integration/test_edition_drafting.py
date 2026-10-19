import sqlite3
from datetime import date

import pytest
from anyio.from_thread import start_blocking_portal

from projects.backend.modules.editions import drafting
from projects.backend.shared.storage.database import SCHEMA_VERSION, connect, initialize
from tests import fakes

FIXTURE_DAY = date(2026, 11, 1)
TARGET = "projects.backend.modules.editions.drafting"


def run_draft(settings, monkeypatch, today=FIXTURE_DAY, **fake):
    requests = fakes.install(monkeypatch, TARGET, **fake)
    with start_blocking_portal() as portal:
        run = portal.call(drafting.draft_edition, settings, today)
    return run, requests


def test_news_edition_is_drafted_and_visible_everywhere(
    client, settings, ingested_event, monkeypatch
):
    run, requests = run_draft(settings, monkeypatch)
    assert (run.status, run.included, run.held, run.skipped_over_limit) == ("completed", 1, 0, 0)
    assert (run.window_start, run.window_end, run.model, run.front_fallback) == (
        "2026-11-01",
        "2026-11-07",
        "qwen3:1.7b",
        False,
    )
    assert len(requests) == 2 and requests[0]["model"] == "qwen3:1.7b"
    assert requests[0]["options"]["num_gpu"] == 0
    facts_prompt = requests[0]["prompt"].split("\nFacts:\n")[1]
    assert "venue_url" not in facts_prompt and "source_url" not in facts_prompt
    facts = ingested_event["events"][0]["facts"]
    page = client.get("/review/editions")
    assert page.status_code == 200
    edition = page.text.split("Run details")[0]
    assert "<h1>Capitol Hill events</h1>" in edition
    assert "1 events between Tuesday, November 3 and Tuesday, November 3." in edition
    assert f"<h2>{facts['title']}</h2>" in edition
    assert f"{facts['title']} is on Tuesday, November 3 at {facts['venue']}." in edition
    assert "When: Tuesday, November 3, 2026" in edition and "Where: Capitol Hill Branch" in edition
    assert "View original event" in edition
    assert "fallback" not in edition.lower()
    assert "No held items." in page.text
    assert "news_blurb_v1" in page.text
    health = client.get("/api/health").json()["latest_edition_draft"]
    assert health["included"] == 1 and health["front_fallback"] is False
    assert client.post("/review/editions").status_code == 405


def test_events_outside_window_are_not_drafted(client, settings, ingested_event, monkeypatch):
    run, requests = run_draft(settings, monkeypatch, today=date(2026, 11, 4))
    assert (run.included, run.held, run.front_fallback) == (0, 0, True)
    assert requests == []
    page = client.get("/review/editions").text
    assert "No items passed automatic checks." in page
    assert "no_items_passed_checks" in page
    run, _ = run_draft(settings, monkeypatch, today=date(2026, 10, 28))
    assert run.included == 1


@pytest.mark.parametrize("outcome", ["injected-claim", "http-error"])
def test_held_items_are_excluded_and_explained(
    client, settings, ingested_event, monkeypatch, outcome
):
    fake = (
        {"item": lambda f: {**fakes.valid_item(f), "blurb": "<b>Free</b> pizza for all."}}
        if outcome == "injected-claim"
        else {"status": 500}
    )
    run, requests = run_draft(settings, monkeypatch, **fake)
    assert (run.status, run.included, run.held, run.front_fallback) == ("completed", 0, 1, True)
    assert len(requests) == 1
    page = client.get("/review/editions").text
    edition, held = page.split("Held text (excluded from the draft)")
    assert "No items passed automatic checks." in edition
    assert ingested_event["events"][0]["facts"]["title"] in held
    if outcome == "injected-claim":
        assert "blurb:unsupported_claim_word:free" in held
        assert "missing_required:title" in held
        assert "&lt;b&gt;Free&lt;/b&gt;" in held
        assert "<b>Free</b>" not in page
    else:
        assert "Generation error: HTTPStatusError" in held


def test_held_front_shows_labelled_fallback_and_rejected_text(
    client, settings, ingested_event, monkeypatch
):
    run, _ = run_draft(
        settings,
        monkeypatch,
        front=lambda _: {"headline": "<i>Free</i> fun", "intro": "Bring the kids."},
    )
    assert (run.included, run.front_fallback) == (1, True)
    page = client.get("/review/editions").text
    edition, held = page.split("Held text (excluded from the draft)")
    assert "<h1>Capitol Hill events: Tuesday, November 3 to Tuesday, November 3</h1>" in edition
    assert "Fixed fallback headline and intro" in edition
    assert "Rejected headline: &lt;i&gt;Free&lt;/i&gt; fun" in held
    assert "intro:unsupported_claim_word:kids" in held
    assert "<i>Free</i>" not in page
    assert client.get("/api/health").json()["latest_edition_draft"]["front_fallback"] is True


def test_model_must_be_installed_and_nothing_is_recorded(settings, ingested_event, monkeypatch):
    with pytest.raises(RuntimeError, match="pull qwen3:1.7b"):
        run_draft(settings, monkeypatch, installed="other:model")
    assert drafting.latest_draft(settings.database) is None


def test_configured_model_overrides_default(settings, ingested_event, monkeypatch):
    settings.ollama_model = "qwen3:4b"
    run, requests = run_draft(settings, monkeypatch, installed="qwen3:4b")
    assert run.model == "qwen3:4b" and requests[0]["model"] == "qwen3:4b"


def test_unexpected_failure_marks_run_failed(client, settings, ingested_event, monkeypatch):
    async def explode(*_):
        raise RuntimeError("fixture crash")

    monkeypatch.setattr(drafting, "draft_item", explode)
    with pytest.raises(RuntimeError, match="fixture crash"):
        run_draft(settings, monkeypatch)
    latest = drafting.latest_draft(settings.database)
    assert latest.status == "failed" and "fixture crash" in latest.error
    assert latest.front_fallback is None
    assert "Run error: RuntimeError: fixture crash" in client.get("/review/editions").text


def test_entry_limit_is_reported(settings, ingested_event, monkeypatch):
    monkeypatch.setattr(drafting, "MAX_ENTRIES", 0)
    run, _ = run_draft(settings, monkeypatch)
    assert (run.included, run.skipped_over_limit) == (0, 1)


def test_empty_and_unavailable_console_states(client, monkeypatch, caplog):
    assert "No draft editions yet." in client.get("/review/editions").text
    assert "/review/editions" in client.get("/review").text

    def fail(_):
        raise sqlite3.OperationalError("fixture database failure")

    monkeypatch.setattr("projects.backend.api.routes.console.inspect_drafts", fail)
    response = client.get("/review/editions")
    assert response.status_code == 503
    assert "Draft editions unavailable." in response.text
    assert "Edition draft inspection unavailable" in caplog.text


def test_entries_are_persisted_with_disposition(settings, ingested_event, monkeypatch):
    run, _ = run_draft(settings, monkeypatch)
    with connect(settings.database) as database:
        rows = database.execute("SELECT * FROM edition_draft_entries").fetchall()
    assert [(row["edition_id"], row["disposition"]) for row in rows] == [(run.id, "checks_passed")]


def test_v3_draft_entries_migrate_to_v4(tmp_path):
    path = tmp_path / "v3.sqlite3"
    initialize(path)
    with connect(path) as database:
        database.execute("DROP TABLE edition_draft_entries")
        database.execute(
            "CREATE TABLE edition_draft_entries (edition_id TEXT NOT NULL, position INTEGER "
            "NOT NULL, source_id TEXT NOT NULL, source_event_id TEXT NOT NULL, event_date TEXT "
            "NOT NULL, disposition TEXT NOT NULL CHECK (disposition IN ('held', "
            "'template_validated')), result_json TEXT NOT NULL, PRIMARY KEY (edition_id, position))"
        )
        database.execute(
            "INSERT INTO edition_drafts (id, community_id, window_start, window_end, model, "
            "validation_policy, status, created_at) VALUES ('old', 'c', '2026-01-01', "
            "'2026-01-07', 'm', 'exact_fact_template_v1', 'completed', 0)"
        )
        database.execute(
            "INSERT INTO edition_draft_entries VALUES "
            "('old', 0, 's', 'e', '2026-01-02', 'template_validated', '{}')"
        )
        database.execute("PRAGMA user_version = 3")
    initialize(path)
    with connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 4
        rows = database.execute("SELECT disposition FROM edition_draft_entries").fetchall()
        assert [row[0] for row in rows] == ["template_validated"]
        database.execute(
            "INSERT INTO edition_draft_entries VALUES "
            "('old', 1, 's', 'f', '2026-01-03', 'checks_passed', '{}')"
        )
