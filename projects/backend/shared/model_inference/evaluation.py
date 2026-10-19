import json
import logging
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from pydantic import BaseModel, ConfigDict

from projects.backend.shared.configuration.settings import ROOT, Settings
from projects.backend.shared.model_inference.fact_template import (
    VALIDATION_POLICY,
    EventDraft,
    EventFacts,
    approved_summary,
    draft_event,
    validate_draft,
)
from projects.backend.shared.model_inference.ollama import OllamaRuntime

logger = logging.getLogger(__name__)
EvaluationFacts = EventFacts
EvaluationDraft = EventDraft
__all__ = ["EvaluationCase", "approved_summary", "evaluate", "validate_draft"]


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
            result = {
                "case_id": case.id,
                **await draft_event(runtime, case.facts, "private synthetic evaluation"),
            }
            results.append(result)
            logger.info(
                "Model evaluation case_id=%s checks_passed=%s wall_seconds=%s",
                case.id,
                result["checks_passed"],
                result["wall_seconds"],
            )
    report = {
        "model": settings.ollama_model,
        "created_at": datetime.now(UTC).isoformat(),
        "scope": "synthetic_local_evaluation_only",
        "manual_review_required": True,
        "validation_policy": VALIDATION_POLICY,
        "limitations": (
            "Fail-closed checks require exact copied fields and an exact deterministic summary. "
            "They do not verify source truth or authorize free-form prose. "
            "Human review of every summary is required. This is not an 8 GB hardware certification."
        ),
        "settings": {"context_tokens": 2048, "output_tokens": 512, "cpu_only": True},
        "cases": results,
    }
    target = settings.data_dir / "model-evaluations"
    target.mkdir(parents=True, exist_ok=True)
    path = target / f"{time.time_ns()}.json"
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return path, all(result["checks_passed"] for result in results)
