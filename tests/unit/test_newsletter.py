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


def candidate(identity, occurrences=1, first_date="2026-11-01", **extra):
    return {
        "id": identity,
        "title": identity,
        "description": None,
        "occurrences": occurrences,
        "venues": ["Branch"],
        "first_date": first_date,
        **extra,
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


def test_every_source_competes_on_score_alone():
    runtime = Runtime(
        [
            {
                "ratings": [
                    rating("event", civic=2),
                    rating("meeting", civic=1),
                    rating("news", appeal=1),
                    rating("quake", civic=3),
                ]
            }
        ]
    )
    pool = [
        candidate("meeting", kind="meeting_preview"),
        candidate("news", kind="state_news", tier="nearby"),
        candidate("quake", kind="earthquake", tier="local"),
        candidate("event"),
    ]
    ranked, _ = asyncio.run(newsworthiness.rank(runtime, pool))
    assert [item["id"] for item in ranked] == ["quake", "event", "meeting", "news"]


def test_rule_fallback_scores_news_zero_and_keeps_meetings_high():
    runtime = Runtime([ValueError("bad json")])
    pool = [
        candidate("trend", kind="trending_topic", tier="nearby"),
        candidate("event"),
        candidate("meeting", kind="meeting_outcome"),
        candidate("news", kind="state_news", tier="region"),
    ]
    ranked, _ = asyncio.run(newsworthiness.rank(runtime, pool))
    assert [(item["id"], item["score"]) for item in ranked] == [
        ("meeting", 10),
        ("event", 1),
        ("news", 0),
        ("trend", 0),
    ]


def test_ties_put_upcoming_events_soonest_and_news_newest_first():
    runtime = Runtime([{"ratings": [rating(i, civic=1) for i in ("e1", "e2", "n1", "n2")]}])
    pool = [
        candidate("e2", first_date="2026-11-03"),
        candidate("e1", first_date="2026-11-02"),
        candidate("n1", first_date="2026-10-28", kind="state_news"),
        candidate("n2", first_date="2026-10-30", kind="state_news"),
    ]
    ranked, _ = asyncio.run(newsworthiness.rank(runtime, pool))
    assert [item["id"] for item in ranked] == ["n2", "n1", "e1", "e2"]


def test_ranking_prompt_tells_the_model_each_kind_and_area():
    pool = [candidate("e"), candidate("q", kind="earthquake", tier="region")]
    data = json.loads(newsworthiness.prompt(pool).split("\nCandidates:\n")[1])
    assert [(item["kind"], item["area"]) for item in data] == [
        ("event", "town"),
        ("earthquake", "county"),
    ]
    assert "trending_topics" in newsworthiness.prompt(pool)


def draft(summary=SUMMARY, headline="Robots take over the lab", **changes):
    return ItemDraft(**{"headline": headline, "summary": summary, **changes})


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
        ("Build robots. Win a raffle.", "summary:unsupported_claim_word:raffle"),
        ("Build robots. Admission is free.", "summary:unsupported_claim_word:free"),
        ("Build robots and program them,", "summary:unfinished_sentence"),
        ("Build robots and program them.\u7121", "summary:foreign_characters"),
    ],
)
def test_item_checks_fail_closed(text, error):
    assert error in story_writer.validate_item(STORY, draft(summary=text))


def test_item_checks_headline():
    errors = story_writer.validate_item(STORY, draft(headline="Free robots on Friday"))
    assert {
        "headline:unsupported_claim_word:free",
        "headline:repeats_when_where",
    } <= set(errors)


def test_item_checks_allow_names_and_numbers():
    text = "Maria Lopez leads two sessions for 6 teams. Build robots."
    assert story_writer.validate_item(STORY, draft(summary=text)) == []


def test_text_checks_allow_accents_and_closing_quotes():
    assert story_writer.style_errors('Hora de cuentos en espa\u00f1ol \u2014 "cuentos."') == []
    assert story_writer.style_errors("No final stop", prose=False) == []
    errors = story_writer.validate_item(STORY, draft(headline="Robots \u7121"))
    assert "headline:foreign_characters" in errors


@pytest.mark.parametrize(
    ("title", "name"),
    [
        ("Chapter 1 Book Club", "Chapter 1 Book Club"),
        ("10-19-2026 City Council agenda: Court Presentation (Leyba)", "City Council agenda"),
        ("Hora de cuentos / Spanish Story Time", "Hora de cuentos"),
        ("Drop-In Mindful Coloring for Adults & Teens", "Drop-In Mindful Coloring"),
        ("Tech Tutors at the Auburn Library", "Tech Tutors"),
    ],
)
def test_event_name_drops_subtitles_audiences_and_dates(title, name):
    assert story_writer.event_name(title) == name


def test_headline_must_keep_the_event_name():
    book_club = {**STORY, "title": "Chapter 1 Book Club"}
    vague = "Tweens explore chapter 1 adventures with snacks and book borrowing"
    assert "headline:drops_event_name" in story_writer.validate_item(
        book_club, draft(headline=vague)
    )
    named = "Chapter 1 Book Club welcomes new readers"
    assert story_writer.validate_item(book_club, draft(headline=named)) == []
    meeting = "10-19-2026 City Council agenda: Budget"
    assert story_writer.name_errors("City Council takes up the budget", meeting) == []
    bilingual = "\u0406\u043d\u0444\u043e \u0446\u0435\u043d\u0442\u0440 / The Welcoming Center"
    assert story_writer.name_errors("The Welcoming Center opens its doors", bilingual) == []


def test_held_front_is_retried_with_the_problems(monkeypatch):
    prompts = []

    async def generate(runtime, prompt, schema):
        prompts.append(prompt)
        return schema(**runtime.responses.pop(0)), {}

    monkeypatch.setattr(story_writer, "_generate", generate)
    story = {**STORY, "title": "Chapter 1 Book Club"}
    item = {"headline": "Chapter 1 Book Club meets", "summary": SUMMARY}
    runtime = Runtime(
        [
            {"headline": "Tweens love books", "intro": "Lots to do this week."},
            {"headline": "Chapter 1 Book Club meets again", "intro": "Lots to do this week."},
        ]
    )
    front = asyncio.run(story_writer.write_front(runtime, "Auburn", "Oct 19", [story], [item]))
    assert (front["fallback"], front["attempts"]) == (False, 2)
    assert front["headline"] == "Chapter 1 Book Club meets again"
    assert front["rejected_first"]["errors"] == ["headline:drops_event_name"]
    assert '"Chapter 1 Book Club", written as is' in prompts[1]


def test_front_falls_back_to_week_title():
    front = story_writer.fallback_front("Auburn", "Oct 19\u201325", True)
    assert front.headline == "Auburn this week: Oct 19\u201325"
    assert story_writer.fallback_front("Auburn", "x", False).intro == story_writer.NO_EVENTS_INTRO
