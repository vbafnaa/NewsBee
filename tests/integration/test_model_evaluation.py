import json

import httpx
import pytest
from anyio.from_thread import start_blocking_portal

from projects.backend.shared.model_inference.evaluation import (
    EvaluationFacts,
    approved_summary,
    evaluate,
)


@pytest.mark.parametrize(
    "outcome", ["valid", "mismatch", "invalid-json", "http-error", "truncated", "injected-claim"]
)
def test_evaluation_adapter_and_saved_report(settings, monkeypatch, outcome):
    requests = []

    def respond(request):
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "fixture:small"}]})
        body = json.loads(request.content)
        requests.append(body)
        facts = json.loads(body["prompt"].split("\nFacts:\n")[1])
        draft = {**facts, "summary": approved_summary(EvaluationFacts.model_validate(facts))}
        if outcome == "injected-claim" and facts["source_event_id"] == "synthetic-003":
            draft["summary"] = "Admission is free."
        if outcome == "mismatch":
            draft["venue"] = "Invented venue"
        if outcome == "http-error":
            return httpx.Response(500)
        return httpx.Response(
            200,
            json={
                "response": "not JSON" if outcome == "invalid-json" else json.dumps(draft),
                "done": True,
                "done_reason": "length" if outcome == "truncated" else "stop",
                "total_duration": 100,
                "load_duration": 10,
                "prompt_eval_count": 100,
                "eval_count": 50,
                "eval_duration": 80,
            },
        )

    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        "projects.backend.shared.model_inference.evaluation.httpx.AsyncClient",
        lambda **kwargs: client_type(transport=httpx.MockTransport(respond), **kwargs),
    )
    settings.ollama_model = "fixture:small"
    with start_blocking_portal() as portal:
        path, passed = portal.call(evaluate, settings)
    assert passed == (outcome == "valid")
    report = json.loads(path.read_text())
    assert report["manual_review_required"] is True
    assert report["scope"] == "synthetic_local_evaluation_only"
    assert len(report["cases"]) == 5
    assert report["validation_policy"] == "exact_fact_template_v1"
    if outcome == "injected-claim":
        assert [case["checks_passed"] for case in report["cases"]] == [
            True,
            True,
            False,
            True,
            True,
        ]
        assert report["cases"][2]["validation_errors"] == ["summary_not_exact_fact_template"]
        assert report["cases"][2]["disposition"] == "held"
    else:
        assert all(case["checks_passed"] == passed for case in report["cases"])
    assert all("wall_seconds" in case for case in report["cases"])
    assert all(request["format"]["properties"]["summary"] for request in requests)
    assert all(request["think"] is False for request in requests)
    assert all(request["options"]["num_gpu"] == 0 for request in requests)
    assert all(request["options"]["num_ctx"] == 2048 for request in requests)
    if outcome == "mismatch":
        assert report["cases"][0]["validation_errors"] == ["changed_field:venue"]
    if outcome == "valid":
        assert report["cases"][1]["draft"]["room"] is None


def test_evaluation_requires_configured_model(settings, monkeypatch):
    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        "projects.backend.shared.model_inference.evaluation.httpx.AsyncClient",
        lambda **kwargs: client_type(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"models": []})),
            **kwargs,
        ),
    )
    with start_blocking_portal() as portal:
        with pytest.raises(RuntimeError, match="no model selected"):
            portal.call(evaluate, settings)
    assert not (settings.data_dir / "model-evaluations").exists()
