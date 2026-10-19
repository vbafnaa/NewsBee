import json

import pytest
from pydantic import ValidationError

from projects.backend.shared.configuration.settings import ROOT
from projects.backend.shared.model_inference.evaluation import (
    EvaluationCase,
    EvaluationDraft,
    approved_summary,
    validate_draft,
)


@pytest.fixture
def cases():
    return [
        EvaluationCase.model_validate(case)
        for case in json.loads((ROOT / "tests" / "fixtures" / "model_evaluation.json").read_text())
    ]


def test_templates_preserve_exact_source_values_and_quote_untrusted_text(cases):
    for case in cases:
        draft = EvaluationDraft(**case.facts.model_dump(), summary=approved_summary(case.facts))
        assert validate_draft(case.facts, draft) == []
        assert json.dumps(case.facts.title) in draft.summary
        if case.facts.room is None:
            assert "Room:" not in draft.summary


@pytest.mark.parametrize(
    "field",
    ["source_event_id", "title", "event_date", "schedule_text", "venue", "room", "source_url"],
)
def test_every_changed_evidence_field_is_rejected(cases, field):
    facts = cases[0].facts
    values = {**facts.model_dump(), field: "Invented value"}
    draft = EvaluationDraft(**values, summary=approved_summary(facts))
    assert validate_draft(facts, draft) == [f"changed_field:{field}"]


@pytest.mark.parametrize(
    "addition",
    [
        " Admission is free.",
        " This is a private event.",
        " Wheelchair access is available.",
        " All ages welcome.",
        " Booking is required.",
        " No room is required.",
        " Times are in PST.",
        " The event has been canceled.",
        " Harmless additional wording.",
        " ",
    ],
)
def test_any_extra_prose_is_held_not_just_known_keywords(cases, addition):
    facts = cases[0].facts
    draft = EvaluationDraft(**facts.model_dump(), summary=approved_summary(facts) + addition)
    assert validate_draft(facts, draft) == ["summary_not_exact_fact_template"]


def test_paraphrases_and_omissions_fail_closed(cases):
    facts = cases[0].facts
    for summary in ("Board games at the library.", facts.title):
        draft = EvaluationDraft(**facts.model_dump(), summary=summary)
        assert validate_draft(facts, draft) == ["summary_not_exact_fact_template"]


def test_shape_validation_rejects_extra_missing_and_wrong_types(cases):
    values = {**cases[0].facts.model_dump(), "summary": approved_summary(cases[0].facts)}
    for invalid in (
        {**values, "price": "free"},
        {**values, "room": 42},
        {key: value for key, value in values.items() if key != "venue"},
    ):
        with pytest.raises(ValidationError):
            EvaluationDraft.model_validate(invalid)
