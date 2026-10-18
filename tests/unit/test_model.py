import httpx
import pytest
from anyio.from_thread import start_blocking_portal

from projects.backend.shared.model_inference.ollama import ModelUnavailableError, OllamaRuntime


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
