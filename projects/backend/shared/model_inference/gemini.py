import httpx

from projects.backend.shared.model_inference.ollama import (
    ModelUnavailableError,
    StructuredGeneration,
)
from shared.contracts.health import ComponentHealth

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"


def _schema(schema: dict, definitions: dict) -> dict:
    reference = schema.get("$ref")
    if reference:
        name = reference.rsplit("/", 1)[-1]
        return _schema(definitions[name], definitions)
    result = {
        key: value
        for key, value in schema.items()
        if key
        in {
            "type",
            "description",
            "enum",
            "format",
            "items",
            "properties",
            "required",
            "minimum",
            "maximum",
            "minLength",
            "maxLength",
        }
    }
    if "anyOf" in schema:
        variants = [item for item in schema["anyOf"] if item.get("type") != "null"]
        if len(variants) == 1:
            return _schema(variants[0], definitions)
        raise ValueError("Gemini structured output does not support this schema union")
    if "items" in result:
        result["items"] = _schema(result["items"], definitions)
    if "properties" in result:
        result["properties"] = {
            key: _schema(value, definitions) for key, value in result["properties"].items()
        }
    return result


class GeminiRuntime:
    provider = "gemini"

    def __init__(self, client: httpx.AsyncClient, api_key: str | None, model: str) -> None:
        self.client = client
        self.api_key = api_key
        self.model = model

    async def health(self) -> ComponentHealth:
        if not self.api_key:
            return ComponentHealth(
                status="not_configured",
                detail="Gemini selected; set NEWSBEE_GEMINI_API_KEY to enable inference.",
            )
        response = await self.client.get(
            f"{API_ROOT}/models/{self.model}",
            headers={"x-goog-api-key": self.api_key},
        )
        response.raise_for_status()
        return ComponentHealth(status="ok", detail=f"Gemini model available: {self.model}")

    async def _generate(
        self, prompt: str, schema: dict | None = None, max_output_tokens: int | None = None
    ) -> dict:
        if not self.api_key:
            raise ModelUnavailableError("Set NEWSBEE_GEMINI_API_KEY before requesting inference")
        generation_config: dict = {"temperature": 0}
        if max_output_tokens is not None:
            generation_config["maxOutputTokens"] = max_output_tokens
        if schema is not None:
            definitions = schema.get("$defs", {})
            generation_config["responseMimeType"] = "application/json"
            generation_config["responseJsonSchema"] = _schema(schema, definitions)
        response = await self.client.post(
            f"{API_ROOT}/models/{self.model}:generateContent",
            headers={"x-goog-api-key": self.api_key},
            json={
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": generation_config,
            },
            timeout=300,
        )
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _text(data: dict) -> str:
        try:
            candidates = data["candidates"]
            if not candidates:
                raise ValueError("Gemini returned no candidates")
            return "".join(
                part["text"]
                for part in candidates[0]["content"]["parts"]
                if "text" in part
            )
        except (KeyError, IndexError, TypeError) as error:
            raise ValueError("Gemini returned an invalid generation response") from error

    async def generate(self, prompt: str) -> str:
        return self._text(await self._generate(prompt))

    async def generate_structured(
        self,
        prompt: str,
        schema: dict,
        num_ctx: int = 2048,
        num_predict: int = 512,
        keep_alive: str | int = 0,
    ) -> StructuredGeneration:
        del num_ctx, keep_alive
        data = await self._generate(prompt, schema, num_predict)
        candidate = data["candidates"][0]
        reason = candidate.get("finishReason")
        usage = data.get("usageMetadata", {})
        return StructuredGeneration(
            response=self._text(data),
            done=reason != "MAX_TOKENS",
            done_reason="length" if reason == "MAX_TOKENS" else reason,
            prompt_eval_count=usage.get("promptTokenCount"),
            eval_count=usage.get("candidatesTokenCount"),
        )
