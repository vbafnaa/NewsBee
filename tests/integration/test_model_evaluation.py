import json

import httpx
import pytest
from anyio.from_thread import start_blocking_portal

from projects.backend.shared.model_inference.evaluation import evaluate
from tests import fakes

TARGET = "projects.backend.shared.model_inference.evaluation"
INJECTIONS = {
    "invented-time": (" It starts at 7pm.", "blurb:unsupported_number:7"),
    "invented-price": (" Admission is free.", "blurb:unsupported_claim_word:free"),
    "invented-name": (" Ask Maria about it.", "blurb:unsupported_name:Maria"),
    "invented-booking": (" Registration required.", "blurb:unsupported_claim_word:registration"),
}


def run(settings, monkeypatch, **fake):
    requests = fakes.install(monkeypatch, TARGET, installed="fixture:small", **fake)
    settings.ollama_model = "fixture:small"
    with start_blocking_portal() as portal:
        path, passed = portal.call(evaluate, settings)
    return json.loads(path.read_text()), passed, requests


def test_valid_news_drafts_pass_and_report_is_saved(settings, monkeypatch):
    report, passed, requests = run(settings, monkeypatch)
    assert passed is True
    assert report["manual_review_required"] is True
    assert report["scope"] == "synthetic_local_evaluation_only"
    assert report["validation_policy"] == "news_blurb_v1"
    assert len(report["cases"]) == 7
    assert all(case["disposition"] == "checks_passed" for case in report["cases"])
    assert report["front"]["checks_passed"] is True and report["front"]["fallback"] is False
    assert report["front"]["context"]["event_count"] == "7"
    assert len(requests) == 8
    assert all(request["think"] is False for request in requests)
    assert all(request["options"]["num_gpu"] == 0 for request in requests)
    assert all(request["options"]["num_ctx"] == 2048 for request in requests)
    assert all(
        "source_url" not in request["prompt"].split("\nFacts:\n")[-1] for request in requests
    )
    assert {"blurb", "headline"} <= set(requests[0]["format"]["properties"])


@pytest.mark.parametrize("outcome", sorted(INJECTIONS))
def test_invented_claims_are_held(settings, monkeypatch, outcome):
    addition, error = INJECTIONS[outcome]

    def item(facts):
        draft = fakes.valid_item(facts)
        if facts["source_event_id"] == "synthetic-006":
            draft["blurb"] += addition
        return draft

    report, passed, _ = run(settings, monkeypatch, item=item)
    assert passed is False
    held = [case for case in report["cases"] if case["disposition"] == "held"]
    assert [case["case_id"] for case in held] == ["tempts-audience-claims"]
    assert error in held[0]["validation_errors"]


def test_held_front_uses_labelled_fallback(settings, monkeypatch):
    report, passed, _ = run(
        settings,
        monkeypatch,
        front=lambda _: {"headline": "Fun online", "intro": "Something for everyone."},
    )
    front = report["front"]
    assert passed is False
    assert front["fallback"] is True and front["fallback_reason"] == "model_text_held"
    assert front["rejected"]["headline"] == "Fun online"
    assert "headline:unsupported_claim_word:online" in front["validation_errors"]
    assert front["headline"].startswith("Capitol Hill events: ")


@pytest.mark.parametrize(
    ("outcome", "fake", "error"),
    [
        ("invalid-json", {"item": lambda _: "not JSON"}, "ValidationError"),
        ("http-error", {"status": 500}, "HTTPStatusError"),
        ("truncated", {"done_reason": "length"}, "ValueError"),
    ],
)
def test_generation_failures_are_held(settings, monkeypatch, outcome, fake, error):
    report, passed, _ = run(settings, monkeypatch, **fake)
    assert passed is False
    assert all(case["disposition"] == "held" for case in report["cases"])
    assert all(case["error"].startswith(error) for case in report["cases"])


def test_changed_identity_is_held(settings, monkeypatch):
    report, passed, _ = run(
        settings,
        monkeypatch,
        item=lambda facts: {**fakes.valid_item(facts), "source_event_id": "x"},
    )
    assert passed is False
    assert all("changed_field:source_event_id" in c["validation_errors"] for c in report["cases"])


def test_evaluation_requires_configured_model(settings, monkeypatch):
    monkeypatch.setattr(
        f"{TARGET}.httpx.AsyncClient",
        lambda **kwargs: fakes.REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"models": []})),
            **kwargs,
        ),
    )
    with start_blocking_portal() as portal:
        with pytest.raises(RuntimeError, match="no model selected"):
            portal.call(evaluate, settings)
    assert not (settings.data_dir / "model-evaluations").exists()
