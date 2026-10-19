"""Units of the newsletter pipeline: descriptions, dedup, newsworthiness and story checks."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from projects.backend.modules.editions import stories
from projects.backend.modules.source_connectors.connectors.common import plain_text
from projects.backend.shared.model_inference import newsworthiness, story_writer
from projects.backend.shared.model_inference.story_writer import ItemDraft

STORY = {
    "id": "s1",
    "title": "Robot Lab",
    "description": "Build and program small robots with LEGO kits. Ages 8 to 12.",
    "venues": ["Ballard Branch"],
}
SUMMARY = "Build and program small robots with LEGO kits. Ages 8 to 12 can join in."


def event(identity, title, day, venue="Ballard Branch", description=None):
    return {
        "source_id": "library:x",
        "facts": {
            "source_event_id": identity,
            "title": title,
            "event_date": f"2026-11-{day:02d}",
            "schedule_text": f"Day {day}, 2026",
            "venue": venue,
            "room": None,
            "source_url": f"https://example.org/{identity}",
            "description": description,
        },
    }


def test_plain_text_strips_markup_and_truncates():
    assert plain_text(None) is None and plain_text("  <br/> ") is None
    assert plain_text("<p>Crafts &amp; <b>songs</b></p><p>All welcome!</p>") == (
        "Crafts & songs. All welcome!"
    )
    assert plain_text("one two three four", limit=12) == "one two..."


def test_collapse_merges_repeats_and_keeps_longest_description():
    collapsed = stories.collapse(
        [
            event("a", "Robot Lab", 3, description="Short."),
            event("b", "ROBOT  lab!", 2, "Central Library", "A much longer description."),
            event("c", "Chess Club", 4),
            event("a", "Robot Lab", 3, description="Short."),
        ]
    )
    assert [story.title for story in collapsed] == ["Robot Lab", "Chess Club"]
    robot = collapsed[0]
    assert [o.source_event_id for o in robot.occurrences] == ["b", "a"]
    assert robot.description == "A much longer description."
    assert robot.venues == ["Central Library", "Ballard Branch"] and robot.recurring
    assert robot.id == stories.collapse([event("z", "robot lab", 9)])[0].id


def test_when_where_single_and_many_occurrences():
    [single] = stories.collapse([event("a", "Talk", 3)])
    assert stories.when_where(single) == "When: Day 3. Where: Ballard Branch."
    [many] = stories.collapse([event(str(day), "Talk", day) for day in range(1, 7)])
    assert stories.when_where(many) == (
        "When and where: Day 1 at Ballard Branch; Day 2 at Ballard Branch; "
        "Day 3 at Ballard Branch; Day 4 at Ballard Branch; plus 2 more."
    )


def test_week_label():
    assert stories.week_label("2026-10-19", "2026-10-25") == "Oct 19\u201325"
    assert stories.week_label("2026-10-29", "2026-11-04") == "Oct 29\u2013Nov 4"


def candidate(identity, occurrences=1, first_date="2026-11-01"):
    return {
        "id": identity,
        "title": identity,
        "description": None,
        "occurrences": occurrences,
        "venues": ["Branch"],
        "first_date": first_date,
    }


class Runtime:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def generate_structured(self, prompt, schema, **options):
        self.calls.append(options)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return SimpleNamespace(done=True, done_reason="stop", response=json.dumps(response))


def rating(identity, category="other", civic=0, appeal=0, special=0):
    return {
        "id": identity,
        "category": category,
        "civic": civic,
        "appeal": appeal,
        "special": special,
    }


def test_weighted_blend_and_rule_tie_breaks():
    assert newsworthiness.WEIGHTS == {"civic": 3, "appeal": 2, "special": 1}
    runtime = Runtime(
        [
            {
                "ratings": [
                    rating("special", special=3),
                    rating("civic", civic=1),
                    rating("appeal", appeal=1),
                    rating("weekly", special=3),
                    rating("later", special=3),
                    rating("not-a-candidate", civic=3),
                ]
            }
        ]
    )
    pool = [
        candidate("weekly", occurrences=4),
        candidate("later", first_date="2026-11-05"),
        candidate("special"),
        candidate("appeal"),
        candidate("civic"),
    ]
    ranked, summary = asyncio.run(newsworthiness.rank(runtime, pool))
    assert [(item["id"], item["score"]) for item in ranked] == [
        ("civic", 3),
        ("special", 3),
        ("later", 3),
        ("weekly", 3),
        ("appeal", 2),
    ]
    assert {item["rated_by"] for item in ranked} == {"model"}
    assert (summary["candidates"], summary["batches"], summary["fallback_ratings"]) == (5, 1, 0)
    assert runtime.calls[0]["keep_alive"] == "10m"


def test_ranking_falls_back_to_rules_per_missing_or_failed_batch(monkeypatch):
    monkeypatch.setattr(newsworthiness, "BATCH_SIZE", 2)
    runtime = Runtime([{"ratings": [rating("a", appeal=3)]}, ValueError("bad json")])
    pool = [candidate("a"), candidate("b", occurrences=3), candidate("c")]
    ranked, summary = asyncio.run(newsworthiness.rank(runtime, pool))
    assert [(i["id"], i["rated_by"], i["rating"]["category"]) for i in ranked] == [
        ("a", "model", "other"),
        ("c", "rule", "other"),
        ("b", "rule", "other"),
    ]
    assert summary["fallback_ratings"] == 2 and summary["batches"] == 2
    assert "ValueError" in summary["batch_reports"][1]["error"]


def draft(summary=SUMMARY, headline="Robots take over the lab", **changes):
    return ItemDraft(**{"id": "s1", "headline": headline, "summary": summary, **changes})


def test_grounded_prose_item_passes():
    assert story_writer.validate_item(STORY, draft()) == []


@pytest.mark.parametrize(
    ("text", "error"),
    [
        ("- Build robots.\n- Program them.", "summary:list_formatting"),
        ("1. Build robots. 2. Program them.", "summary:list_formatting"),
        ("Build robots on Tuesday.", "summary:repeats_when_where"),
        ("Join us in November to build robots.", "summary:repeats_when_where"),
        ("Build robots. Build robots.", "summary:repeated_sentence"),
        ("Robots take over the lab. Build robots.", "summary:repeats_headline"),
        ("Build robots. Pizza is served.", "summary:unsupported_claim_word:pizza"),
        ("Build robots. Admission is free.", "summary:unsupported_claim_word:free"),
        ("Build robots with Maria.", "summary:unsupported_name:Maria"),
        ("Build robots. Ages 6 and up.", "summary:unsupported_number:6"),
    ],
)
def test_item_checks_fail_closed(text, error):
    assert error in story_writer.validate_item(STORY, draft(summary=text))


def test_item_checks_headline_and_id():
    errors = story_writer.validate_item(STORY, draft(headline="Free robots on Friday", id="x"))
    assert {
        "changed_field:id",
        "headline:unsupported_claim_word:free",
        "headline:repeats_when_where",
    } <= set(errors)


def test_front_falls_back_to_week_title():
    front = story_writer.fallback_front("Auburn", "Oct 19\u201325", True)
    assert front.headline == "Auburn this week: Oct 19\u201325"
    assert story_writer.fallback_front("Auburn", "x", False).intro == story_writer.NO_EVENTS_INTRO
