import json

import httpx
import pytest
from anyio.from_thread import start_blocking_portal

from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.model_inference.gemini import GeminiRuntime
from projects.backend.shared.model_inference.newsworthiness import Ratings
from projects.backend.shared.model_inference.ollama import ModelUnavailableError, OllamaRuntime
from projects.backend.shared.model_inference.runtime import create_runtime


def test_model_not_selected():
    async def check():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"models": []}))
        ) as client:
            runtime = OllamaRuntime(client, "http://localhost:11434", None)
            assert (await runtime.health()).status == "not_configured"
            with pytest.raises(ModelUnavailableError):
                await runtime.generate("test")

    with start_blocking_portal() as portal:
        portal.call(check)


def test_missing_and_installed_models():
    async def check():
        transport = httpx.MockTransport(
            lambda _: httpx.Response(200, json={"models": [{"name": "fixture:small"}]})
        )
        async with httpx.AsyncClient(transport=transport) as client:
            runtime = OllamaRuntime(client, "http://localhost:11434", "missing")
            assert (await runtime.health()).status == "unavailable"
            runtime.model = "fixture:small"
            assert (await runtime.health()).status == "ok"

    with start_blocking_portal() as portal:
        portal.call(check)


def test_model_http_errors_propagate():
    async def check():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(500))
        ) as client:
            runtime = OllamaRuntime(client, "http://localhost:11434", "fixture:small")
            with pytest.raises(httpx.HTTPStatusError):
                await runtime.generate("test")

    with start_blocking_portal() as portal:
        portal.call(check)


def test_gemini_runtime_health_and_structured_output():
    requests = []

    def respond(request):
        requests.append(
            {
                "method": request.method,
                "headers": request.headers,
                "url": str(request.url),
                "body": request.content,
            }
        )
        if request.method == "GET":
            return httpx.Response(200, json={"name": "models/gemini-2.5-flash"})
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "finishReason": "STOP",
                        "content": {"parts": [{"text": '{"ratings":[]}'}]},
                    }
                ],
                "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 4},
            },
        )

    async def check():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            settings = Settings(model_provider="gemini", gemini_api_key="test-secret")
            runtime = create_runtime(settings, client)
            assert isinstance(runtime, GeminiRuntime)
            assert (await runtime.health()).status == "ok"
            generation = await runtime.generate_structured(
                "Return no ratings", Ratings.model_json_schema()
            )
            assert generation.done
            assert generation.response == '{"ratings":[]}'
            assert generation.prompt_eval_count == 12
            assert requests[0]["headers"]["x-goog-api-key"] == "test-secret"
            assert "test-secret" not in requests[0]["url"]
            body = json.loads(requests[1]["body"])
            assert body["generationConfig"]["maxOutputTokens"] == 512
            assert body["generationConfig"]["responseJsonSchema"]["properties"]

    with start_blocking_portal() as portal:
        portal.call(check)


def test_gemini_without_key_is_not_configured_and_cannot_generate():
    async def check():
        async with httpx.AsyncClient() as client:
            runtime = GeminiRuntime(client, None, "gemini-2.5-flash")
            assert (await runtime.health()).status == "not_configured"
            with pytest.raises(ModelUnavailableError):
                await runtime.generate("test")

    with start_blocking_portal() as portal:
        portal.call(check)
