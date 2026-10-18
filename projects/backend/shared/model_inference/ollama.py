from typing import Protocol

import httpx
from pydantic import BaseModel

from shared.contracts.health import ComponentHealth


class ModelUnavailableError(RuntimeError):
    pass


class GenerateResponse(BaseModel):
    response: str


class ModelRuntime(Protocol):
    async def health(self) -> ComponentHealth: ...

    async def generate(self, prompt: str) -> str: ...


class OllamaRuntime:
    def __init__(self, client: httpx.AsyncClient, url: str, model: str | None) -> None:
        self.client = client
        self.url = url
        self.model = model

    async def health(self) -> ComponentHealth:
        response = await self.client.get(f"{self.url}/api/tags")
        response.raise_for_status()
        data = response.json()
        models = data["models"]
        if not isinstance(models, list):
            raise ValueError("Ollama returned an invalid model list")
        if not self.model:
            return ComponentHealth(
                status="not_configured",
                detail="Ollama is reachable; no model selected. No automatic model downloads.",
            )
        names = {model["name"] for model in models}
        if self.model not in names:
            return ComponentHealth(
                status="unavailable", detail=f"Configured model is not installed: {self.model}"
            )
        return ComponentHealth(status="ok", detail=f"Configured model installed: {self.model}")

    async def generate(self, prompt: str) -> str:
        if not self.model:
            raise ModelUnavailableError("Select NEWSBEE_OLLAMA_MODEL before requesting inference")
        response = await self.client.post(
            f"{self.url}/api/generate",
            json={"model": self.model, "prompt": prompt, "stream": False},
            timeout=300,
        )
        response.raise_for_status()
        return GenerateResponse.model_validate(response.json()).response
