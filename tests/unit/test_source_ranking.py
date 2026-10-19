"""Per-source ranking rules: each connector type orders its own stories."""

from types import SimpleNamespace

from projects.backend.modules.source_connectors import ranking


def story(title, date="2026-11-03", recurring=False, **facts):
    return SimpleNamespace(
        title=title, recurring=recurring, first=SimpleNamespace(event_date=date), facts=facts
    )


def titles(kind, stories):
    return [item.title for item in ranking.rank(kind, stories)]


def test_source_type_comes_from_the_source_id():
    assert ranking.source_type("library:WA0059") == "library"
    assert ranking.source_type("meetings:civicclerk:auburnwa") == "meetings"


def test_library_ranks_one_off_then_practical_then_soonest():
    pool = [
        story("Weekly Storytime", "2026-11-01", recurring=True),
        story("Lego Club", "2026-11-02"),
        story("Tax Help Clinic", "2026-11-05"),
        story("Job Search Help", "2026-11-04", recurring=True),
        story("Author Talk", "2026-11-01"),
    ]
    assert titles("library", pool) == [
        "Tax Help Clinic",
        "Author Talk",
        "Lego Club",
        "Job Search Help",
        "Weekly Storytime",
    ]


def test_meetings_rank_council_first_then_sooner_then_fuller_agendas():
    pool = [
        story("Parks Board agenda: Trails", "2026-11-01", body="Parks Board", agenda_items=9),
        story("City Council agenda: Zoning", "2026-11-05", body="City Council", agenda_items=1),
        story("City Council agenda: Budget", "2026-11-03", body="City Council", agenda_items=2),
        story("City Council agenda: Levy", "2026-11-03", body="City Council", agenda_items=6),
    ]
    assert titles("meetings", pool) == [
        "City Council agenda: Levy",
        "City Council agenda: Budget",
        "City Council agenda: Zoning",
        "Parks Board agenda: Trails",
    ]


def test_unknown_source_types_fall_back_to_soonest():
    pool = [story("Later", "2026-11-04"), story("Sooner", "2026-11-02")]
    assert titles("calendar", pool) == ["Sooner", "Later"]
