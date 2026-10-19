import json
import sqlite3
from datetime import date

import httpx
import pytest
from anyio.from_thread import start_blocking_portal

from projects.backend.modules.editions import drafting
from projects.backend.shared.model_inference.fact_template import EventFacts, approved_summary
from projects.backend.shared.storage.database import connect

FIXTURE_DAY = date(2026, 11, 1)
REAL_CLIENT = httpx.AsyncClient


def run_draft(settings, monkeypatch, outcome="valid", installed="qwen3:1.7b", today=FIXTURE_DAY):
    requests = []

    def respond(request):
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": installed}]})
        body = json.loads(request.content)
        requests.append(body)
        if outcome == "http-error":
            return httpx.Response(500)
        facts = json.loads(body["prompt"].split("\nFacts:\n")[1])
        draft = {**facts, "summary": approved_summary(EventFacts.model_validate(facts))}
        if outcome == "injected-claim":
            draft["summary"] = "<b>Free</b> admission for everyone."
        return httpx.Response(
            200,
            json={
                "response": json.dumps(draft),
                "done": True,
                "done_reason": "stop",
                "total_duration": 100,
                "load_duration": 10,
                "prompt_eval_count": 100,
                "eval_count": 50,
                "eval_duration": 80,
            },
        )

    monkeypatch.setattr(
        "projects.backend.modules.editions.drafting.httpx.AsyncClient",
        lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(respond), **kwargs),
    )
    with start_blocking_portal() as portal:
        run = portal.call(drafting.draft_edition, settings, today)
    return run, requests


def test_valid_entry_is_included_and_visible_everywhere(
    client, settings, ingested_event, monkeypatch
):
    run, requests = run_draft(settings, monkeypatch)
    assert (run.status, run.included, run.held, run.skipped_over_limit) == ("completed", 1, 0, 0)
    assert (run.window_start, run.window_end, run.model) == (
        "2026-11-01",
        "2026-11-07",
        "qwen3:1.7b",
    )
    assert requests[0]["model"] == "qwen3:1.7b"
    assert requests[0]["options"]["num_gpu"] == 0
    assert "venue_url" not in requests[0]["prompt"].split("\nFacts:\n")[1]
    facts = ingested_event["events"][0]["facts"]
    page = client.get("/review/editions")
    assert page.status_code == 200
    included = page.text.split("Held entries")[0]
    assert facts["title"] in included
    assert "Event title: &#34;Example neighborhood workshop&#34;" in included
    assert "No held entries." in page.text
    assert "exact_fact_template_v1" in page.text
    health = client.get("/api/health").json()["latest_edition_draft"]
    assert health["included"] == 1 and health["status"] == "completed"
    assert client.post("/review/editions").status_code == 405


def test_events_outside_window_are_not_drafted(settings, ingested_event, monkeypatch):
    run, requests = run_draft(settings, monkeypatch, today=date(2026, 11, 4))
    assert (run.included, run.held) == (0, 0)
    assert requests == []
    run, _ = run_draft(settings, monkeypatch, today=date(2026, 10, 28))
    assert run.included == 1


@pytest.mark.parametrize("outcome", ["injected-claim", "http-error"])
def test_held_entries_are_excluded_and_explained(
    client, settings, ingested_event, monkeypatch, outcome
):
    run, _ = run_draft(settings, monkeypatch, outcome=outcome)
    assert (run.status, run.included, run.held) == ("completed", 0, 1)
    page = client.get("/review/editions").text
    included, held = page.split("Held entries")
    assert "No included entries." in included
    assert ingested_event["events"][0]["facts"]["title"] in held
    if outcome == "injected-claim":
        assert "summary_not_exact_fact_template" in held
        assert "&lt;b&gt;Free&lt;/b&gt;" in held
        assert "<b>Free</b>" not in page
    else:
        assert "Generation error: HTTPStatusError" in held


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

    monkeypatch.setattr(drafting, "draft_event", explode)
    with pytest.raises(RuntimeError, match="fixture crash"):
        run_draft(settings, monkeypatch)
    latest = drafting.latest_draft(settings.database)
    assert latest.status == "failed" and "fixture crash" in latest.error
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
    assert [(row["edition_id"], row["disposition"]) for row in rows] == [
        (run.id, "template_validated")
    ]
