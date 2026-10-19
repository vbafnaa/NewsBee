import json
import logging
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from pydantic import BaseModel, ConfigDict

from projects.backend.shared.configuration.settings import ROOT, Settings
from projects.backend.shared.model_inference.news_blurb import (
    VALIDATION_POLICY,
    EventFacts,
    draft_front,
    draft_item,
)
from projects.backend.shared.model_inference.ollama import OllamaRuntime

logger = logging.getLogger(__name__)


class EvaluationCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    facts: EventFacts


async def evaluate(settings: Settings, fixture: Path | None = None) -> tuple[Path, bool]:
    fixture = fixture or ROOT / "tests" / "fixtures" / "model_evaluation.json"
    cases = [EvaluationCase.model_validate(item) for item in json.loads(fixture.read_text())]
    if not cases:
        raise ValueError("Model evaluation requires at least one synthetic case")
    results = []
    async with httpx.AsyncClient(trust_env=False, timeout=10) as client:
        runtime = OllamaRuntime(client, settings.ollama_url, settings.ollama_model)
        health = await runtime.health()
        if health.status != "ok":
            raise RuntimeError(health.detail)
        for case in cases:
            result = {"case_id": case.id, **await draft_item(runtime, case.facts)}
            results.append(result)
            logger.info(
                "Model evaluation case_id=%s checks_passed=%s errors=%s wall_seconds=%s",
                case.id,
                result["checks_passed"],
                result["validation_errors"] or result.get("error"),
                result["wall_seconds"],
            )
        front = await draft_front(runtime, [case.facts for case in cases], "Capitol Hill")
        logger.info(
            "Model evaluation front checks_passed=%s errors=%s",
            front["checks_passed"],
            front["validation_errors"] or front.get("error"),
        )
    report = {
        "model": settings.ollama_model,
        "created_at": datetime.now(UTC).isoformat(),
        "scope": "synthetic_local_evaluation_only",
        "manual_review_required": True,
        "validation_policy": VALIDATION_POLICY,
        "limitations": (
            "Rule-based checks hold text that adds numbers, names, or claim vocabulary not in "
            "the facts. They cannot prove a blurb is true or catch every unsupported claim. "
            "Human review of every item is required. This is not an 8 GB hardware certification."
        ),
        "settings": {"context_tokens": 2048, "output_tokens": 512, "cpu_only": True},
        "cases": results,
        "front": front,
    }
    target = settings.data_dir / "model-evaluations"
    target.mkdir(parents=True, exist_ok=True)
    path = target / f"{time.time_ns()}.json"
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    passed = all(result["checks_passed"] for result in results) and front["checks_passed"]
    return path, passed
