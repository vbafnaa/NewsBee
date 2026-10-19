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


CATEGORIES = [
    "civic_and_practical",
    "early_learning",
    "kids_and_family",
    "teens",
    "arts_and_culture",
    "books_and_authors",
    "classes_and_workshops",
    "technology",
    "health_and_wellness",
    "social_and_games",
    "exhibits",
    "other",
]


def valid_ranking(candidates: list[dict]) -> dict:
    """Distinct categories, equal scores: rule tie-breakers decide the order."""
    return {
        "ratings": [
            {
                "id": item["id"],
                "category": CATEGORIES[index % len(CATEGORIES)],
                "civic": 0,
                "appeal": 1,
                "special": 1,
            }
            for index, item in enumerate(candidates)
        ]
    }


def valid_story(story: dict) -> dict:
    return {
        "headline": f"Don't miss {story['title']}"[:90],
        "summary": f"Join us for {story['title']}.",
    }


def valid_edition_front(context: dict) -> dict:
    return {
        "headline": f"{context['stories'][0]['title']} this week"[:90],
        "intro": f"Here is what is on around {context['community']}.",
    }


def valid_email(context: dict) -> dict:
    return {"blurb": f"Find out what is on around {context['community']} this week."}


def install(
    monkeypatch,
    target: str,
    installed: str = "qwen3:4b",
    item=valid_item,
    front=valid_front,
    ranking=valid_ranking,
    story=valid_story,
    edition_front=valid_edition_front,
    email=valid_email,
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
        markers = {
            "\nFront facts:\n": front,
            "\nCandidates:\n": ranking,
            "\nStory:\n": story,
            "\nEdition:\n": edition_front,
            "\nEmail:\n": email,
        }
        marker = next((m for m in markers if m in prompt), None)
        if marker:
            draft = markers[marker](json.loads(prompt.split(marker)[1].split("\n")[0]))
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
