import httpx

from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.model_inference.gemini import GeminiRuntime
from projects.backend.shared.model_inference.ollama import ModelRuntime, OllamaRuntime


def create_runtime(
    settings: Settings, client: httpx.AsyncClient, model: str | None = None
) -> ModelRuntime:
    if settings.model_provider == "gemini":
        return GeminiRuntime(client, settings.gemini_api_key, model or settings.gemini_model)
    return OllamaRuntime(client, settings.ollama_url, model or settings.ollama_model)


def configured_model(settings: Settings) -> str | None:
    return settings.gemini_model if settings.model_provider == "gemini" else settings.ollama_model
