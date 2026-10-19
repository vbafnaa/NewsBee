import json

import pytest
from pydantic import ValidationError

from projects.backend.shared.configuration.settings import ROOT
from projects.backend.shared.model_inference.evaluation import EvaluationCase
from projects.backend.shared.model_inference.news_blurb import (
    EventFacts,
    FrontDraft,
    ItemDraft,
    added_claims,
    date_display,
    fallback_front,
    front_context,
    validate_front,
    validate_item,
    when_where,
)
from tests.fakes import valid_front, valid_item

FACTS = EventFacts(
    source_event_id="synthetic-001",
    title="Neighborhood Board Games",
    event_date="2026-11-03",
    schedule_text="Tuesday, November 3, 2026, 3 - 4pm",
    venue="Example Library",
    room="Meeting Room",
    source_url="https://example.org/events/synthetic-001",
)
BASE = "Neighborhood Board Games is on Tuesday, November 3 at Example Library."


def item(blurb=BASE, headline="Board games at the library", **changes) -> ItemDraft:
    return ItemDraft(
        source_event_id=changes.get("source_event_id", FACTS.source_event_id),
        headline=headline,
        blurb=blurb,
    )


@pytest.fixture
def cases():
    return [
        EvaluationCase.model_validate(case)
        for case in json.loads((ROOT / "tests" / "fixtures" / "model_evaluation.json").read_text())
    ]


def test_display_helpers_use_only_facts():
    assert date_display("2026-11-03") == "Tuesday, November 3"
    assert when_where(FACTS) == (
        "When: Tuesday, November 3, 2026, 3 - 4pm. Where: Example Library, Meeting Room."
    )


def test_valid_news_items_pass_for_every_fixture(cases):
    for case in cases:
        facts = {**case.facts.model_dump(), "date_text": date_display(case.facts.event_date)}
        draft = ItemDraft.model_validate(valid_item(facts))
        assert validate_item(case.facts, draft) == [], case.id


def test_natural_wording_passes():
    draft = item(
        headline="Board games at Example Library",
        blurb="Join neighbors for Neighborhood Board Games on Tuesday, November 3 "
        "at Example Library. The games run from 3 to 4pm in the Meeting Room.",
    )
    assert validate_item(FACTS, draft) == []


@pytest.mark.parametrize(
    ("addition", "error"),
    [
        (" Come in the evening.", "blurb:unsupported_claim_word:evening"),
        (" Admission is free.", "blurb:unsupported_claim_word:free"),
        (" Tickets cost $5.", "blurb:unsupported_claim_word:cost"),
        (" Registration is required.", "blurb:unsupported_claim_word:registration"),
        (" RSVP to save a seat.", "blurb:unsupported_claim_word:rsvp"),
        (" Tickets are limited.", "blurb:unsupported_claim_word:tickets"),
        (" It is also online.", "blurb:unsupported_claim_word:online"),
        (" It is wheelchair accessible.", "blurb:unsupported_claim_word:wheelchair"),
        (" Doors open at noon.", "blurb:unsupported_claim_word:noon"),
        (" Details at example.org/games.", "blurb:link_or_handle"),
        (" The event has been canceled.", "blurb:unsupported_claim_word:canceled"),
    ],
)
def test_invented_claims_are_held(addition, error):
    errors = validate_item(FACTS, item(blurb=BASE + addition))
    assert error in errors


@pytest.mark.parametrize(
    "addition",
    [" Hosted by Maria Lopez.", " Bring two friends.", " Over 6 tables.", " Games on Saturday."],
)
def test_names_and_numbers_are_not_checked(addition):
    assert validate_item(FACTS, item(blurb=BASE + addition)) == []


def test_audience_role_and_tone_words_are_allowed():
    blurb = BASE + " Kids, families and adults bring snacks."
    assert validate_item(FACTS, item(blurb=blurb)) == []


def test_too_many_sentences_and_lines_are_held():
    assert "blurb:too_many_sentences" in validate_item(
        FACTS, item(blurb=BASE + " Bring a game. Bring a friend.")
    )
    assert "headline:multiple_lines" in validate_item(FACTS, item(headline="Games\nnight"))


def test_headline_is_checked_too():
    assert "headline:unsupported_claim_word:free" in validate_item(
        FACTS, item(headline="Free board games")
    )


def test_required_facts_and_identity_must_be_present():
    errors = validate_item(
        FACTS, item(blurb="Board games at the library.", source_event_id="other")
    )
    assert errors[:4] == [
        "changed_field:source_event_id",
        "missing_required:title",
        "missing_required:date",
        "missing_required:venue",
    ]


def test_claim_words_from_source_text_are_quoted_data_not_new_claims(cases):
    case = next(c for c in cases if c.id == "instruction-like-title")
    blurb = f"{case.facts.title} is on Thursday, November 5 at {case.facts.venue}."
    draft = ItemDraft(source_event_id=case.facts.source_event_id, headline="Notice", blurb=blurb)
    assert validate_item(case.facts, draft) == []


def test_front_checks_and_fallback(cases):
    facts = [case.facts for case in cases]
    context = front_context(facts, "Capitol Hill")
    assert validate_front(context, FrontDraft.model_validate(valid_front(context))) == []
    bad = FrontDraft(headline="Fun online", intro="Something for the whole family at noon.")
    errors = validate_front(context, bad)
    assert "headline:unsupported_claim_word:online" in errors
    assert "intro:unsupported_claim_word:noon" in errors
    fallback = fallback_front(context, "Capitol Hill")
    assert validate_front(context, fallback) == []
    assert str(len(facts)) in fallback.intro
    assert fallback_front(None, "Ballard").headline == "Ballard events"


def test_fallback_front_fits_many_venues(cases):
    facts = [
        case.facts.model_copy(update={"venue": f"Branch number {index} with a long venue name"})
        for index, case in enumerate(cases * 20)
    ]
    context = front_context(facts, "Seattle")
    fallback = fallback_front(context, "Seattle")
    assert "Branch number" not in fallback.intro
    assert validate_front(context, fallback) == []


def test_shape_validation_rejects_extra_missing_wrong_types_and_long_text():
    values = item().model_dump()
    for invalid in (
        {**values, "price": "free"},
        {**values, "blurb": 42},
        {key: value for key, value in values.items() if key != "headline"},
        {**values, "blurb": "x" * 321},
        {**values, "headline": "x" * 91},
    ):
        with pytest.raises(ValidationError):
            ItemDraft.model_validate(invalid)


def test_added_claims_ignores_punctuation_inside_allowed_text():
    allowed = ['"Open" Studio; bring your own materials. Really!']
    assert added_claims(f"{allowed[0]} is here.", allowed, 1) == []
