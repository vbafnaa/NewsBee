"""Fake local Ollama responses shared by evaluation, drafting, and browser tests."""

import json

import httpx

REAL_ASYNC_CLIENT = httpx.AsyncClient


def valid_item(facts: dict) -> dict:
    return {
        "source_event_id": facts["source_event_id"],
        "headline": facts["title"][:90],
        "blurb": f"{facts['title']} is on {facts['date_text']} at {facts['venue']}.",
    }


def valid_front(context: dict) -> dict:
    return {
        "headline": f"{context['community']} events",
        "intro": (
            f"{context['event_count']} events between {context['first_date']} "
            f"and {context['last_date']}."
        ),
    }


def install(
    monkeypatch,
    target: str,
    installed: str = "qwen3:1.7b",
    item=valid_item,
    front=valid_front,
    status: int = 200,
    done_reason: str = "stop",
) -> list[dict]:
    """Patch `<target>.httpx.AsyncClient`; returns the list of captured generate requests."""
    requests: list[dict] = []

    def respond(request):
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": installed}]})
        body = json.loads(request.content)
        requests.append(body)
        if status != 200:
            return httpx.Response(status)
        prompt = body["prompt"]
        if "\nFront facts:\n" in prompt:
            draft = front(json.loads(prompt.split("\nFront facts:\n")[1]))
        else:
            draft = item(json.loads(prompt.split("\nFacts:\n")[1]))
        return httpx.Response(
            200,
            json={
                "response": draft if isinstance(draft, str) else json.dumps(draft),
                "done": True,
                "done_reason": done_reason,
                "total_duration": 100,
                "load_duration": 10,
                "prompt_eval_count": 100,
                "eval_count": 50,
                "eval_duration": 80,
            },
        )

    monkeypatch.setattr(
        f"{target}.httpx.AsyncClient",
        lambda **kwargs: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(respond), **kwargs),
    )
    return requests
