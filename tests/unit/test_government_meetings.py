from datetime import date, datetime

import httpx
import pytest

from projects.backend.modules.editions import stories
from projects.backend.modules.source_connectors.agents import government_meetings
from projects.backend.modules.source_connectors.connectors import civicclerk, legistar, meetings
from projects.backend.shared.model_inference import story_writer
from tests import meetings_world as world
from tests.library_world import TODAY


def collect(table: dict, platform="legistar", tenant=world.LEGISTAR, seen=None):
    location = {"id": "exampletown-wa", "name": world.TOWN}
    location["government"] = world.government(platform, tenant)
    with httpx.Client(transport=world.transport(table, seen)) as client:
        return government_meetings.collect(location, client, TODAY, world.WINDOW)


@pytest.mark.parametrize(
    "title",
    [
        "CALL TO ORDER",
        "Roll Call",
        "Approval of the Agenda",
        "Approve minutes of the October 6 meeting",
        "September 28, 2026 Retirement Board Meeting Minutes - C/T",
        "September 10th Minutes",
        "PUBLIC FORUM - Verbal Comments",
        "Public Comment",
        "Old Business",
        "Staff Reports",
        "Treasurer's Report",
        "Commissioner Items",
        "Vote Anticipated",
        "Adjournment",
        "Requests for reasonable accommodation: call the clerk",
        "Jane Doe (tenant); Acme LLC (landlord) Security Deposit Case Re: 4 Elm Street",
        "Kadeem Noel, Class B $4,158.38; Effective Date of Benefit: 09/01/26",
        "\u2022 ",
    ],
)
def test_procedural_boilerplate_and_private_items_are_dropped(title):
    assert meetings.item_title(title) is None


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("An ordinance banning glue traps.", "An ordinance banning glue traps"),
        ("\u2022 Adopt the 2027 school calendar", "Adopt the 2027 school calendar"),
        ("Update on playgrounds (15 minutes)", "Update on playgrounds (15 minutes)"),
        (
            "ZP-26-432; 28 Janet Circle. Conditional use",
            "ZP-26-432; 28 Janet Circle. Conditional use",
        ),
    ],
)
def test_substantive_items_are_kept(title, expected):
    assert meetings.item_title(title) == expected


@pytest.mark.parametrize(
    ("body", "role"),
    [
        ("City Council", "is the elected body that sets local laws"),
        ("Council on Aging", "is a public body of Exampletown's local government"),
        ("Planning Commission", "reviews land-use, zoning and development proposals"),
        ("Board of Education", "governs the local public schools"),
        ("Zoning Board of Appeals", "hears appeals"),
        ("Finance Committee", "oversees public money"),
        ("Ad Hoc Committee", "is a committee of the local government"),
    ],
)
def test_context_explains_what_the_body_does(body, role):
    sentence = meetings.context(body, "Exampletown")
    assert sentence.startswith(f"The {body} ") and role in sentence


def test_body_names_drop_meeting_suffixes():
    assert meetings.body_name("Board of Education Regular Meeting") == "Board of Education"
    assert meetings.body_name("City Council - Special Meeting") == "City Council"
    assert meetings.body_name("Meeting") == "Meeting"


def test_select_prefers_substantive_business_and_dedupes():
    items = [
        meetings.Item("Consent item", consent=True, weight=3),
        meetings.Item("Same ordinance", weight=3, outcome="Held and Closed"),
        meetings.Item("Discussion", weight=0),
        meetings.Item("same ordinance", weight=4, outcome="Adopted"),
    ]
    assert [(i.title, i.outcome) for i in meetings.select(items)] == [
        ("same ordinance", "Adopted"),
        ("Discussion", None),
        ("Consent item", None),
    ]


def test_preview_caps_items_and_marks_draft_agendas():
    meeting = meetings.Meeting(
        "1",
        "City Council",
        date(2026, 11, 3),
        None,
        "https://example.gov/m/1",
        [meetings.Item(f"Item {n}") for n in range(7)],
        draft_agenda=True,
    )
    facts = meetings.preview(meeting, "Exampletown")
    assert facts.title == "City Council agenda: Item 0"
    assert "Item 4" in facts.description and "Item 5" not in facts.description
    assert "The full agenda lists 2 more items." in facts.description
    assert "draft and may change" in facts.description
    assert (facts.venue, facts.event_date, facts.kind) == (
        meetings.NO_VENUE,
        "2026-11-03",
        "meeting_preview",
    )
    assert meetings.preview(meeting.__class__(**{**meeting.__dict__, "items": []}), "X") is None


def test_legistar_window_previews_upcoming_and_reports_recent_outcomes():
    seen = []
    result, facts = collect(world.legistar_routes(), seen=seen)
    preview, outcome = facts
    assert preview.title == "City Council agenda: An ordinance banning glue traps"
    assert preview.description == (
        "The City Council is the elected body that sets local laws, policies and the budget. "
        "On the agenda: An ordinance banning glue traps; Resolution approving the playground "
        "contract. Note from the clerk: Comments are taken in person."
    )
    assert (preview.event_date, preview.schedule_text) == (
        "2026-11-03",
        "Tuesday, November 3, 2026, 7pm",
    )
    assert preview.venue == "City Hall, 1 Main St"
    assert outcome.kind == "meeting_outcome" and outcome.event_date == "2026-10-28"
    assert outcome.title == "City Council decisions: Ordinance on short-term rentals"
    assert (
        "Recorded outcomes: Ordinance on short-term rentals (Adopted on Second Reading); "
        "Resolution to rename Elm Park (Failed)."
    ) in outcome.description
    assert "official minutes are not yet approved" in outcome.description
    assert result["source_id"] == "meetings:legistar:exampletown"
    assert (result["status"], result["event_count"], result["skipped_outside_window"]) == (
        "ingested",
        2,
        1,
    )
    assert result["skipped_unusable"] == {"cancelled": 1, "no_recorded_outcomes": 1}
    assert result["detail"] == "legistar API: 1 upcoming agendas, 1 recent outcomes"
    assert len(result["response_sha256"]) == 64
    items = [url for url in seen if "/eventitems" in url]
    assert len(items) == 3 and not any("/events/2/" in url or "/events/4/" in url for url in items)


def test_legistar_reads_separate_date_and_time():
    assert legistar.start({"EventDate": "2026-11-03T00:00:00", "EventTime": "7:00 PM"}) == (
        datetime(2026, 11, 3, 19, 0)
    )
    assert legistar.start({"EventDate": "2026-11-03T00:00:00", "EventTime": None}) == date(
        2026, 11, 3
    )


def test_civicclerk_previews_published_agendas_only():
    result, [facts] = collect(world.civicclerk_routes(), "civicclerk", world.CIVICCLERK)
    assert facts.title == "Board of Education agenda: Adopt the 2027 school calendar"
    assert facts.description == (
        "The Board of Education governs the local public schools. On the agenda: Adopt the "
        "2027 school calendar; Update on the new middle school (15 minutes)."
    )
    assert facts.schedule_text == "Monday, November 2, 2026, 6pm"
    assert facts.venue == "1 School St, Exampleville"
    assert facts.source_url == "https://exampleville.portal.civicclerk.com/event/10/overview"
    assert result["skipped_unusable"] == {"cancelled": 1, "agenda_not_posted": 1}


def test_civicclerk_venue_may_be_missing():
    assert civicclerk.venue({"eventLocation": {"address1": " ", "city": None}}) is None


def test_collect_skips_locations_without_a_platform():
    location = {"id": "x", "name": world.TOWN}
    location["government"] = {**world.government(), "status": "no_platform", "platform": None}
    with httpx.Client(transport=world.transport({})) as client:
        result, facts = government_meetings.collect(location, client, TODAY, world.WINDOW)
    assert (result["status"], facts) == ("no_feed", [])


def test_collect_raises_rate_limits_and_records_bad_responses():
    table = world.legistar_routes()
    table[world.key(legistar.items_url(world.LEGISTAR, 1))] = httpx.Response(429)
    with pytest.raises(httpx.HTTPStatusError):
        collect(table)
    table[world.key(legistar.items_url(world.LEGISTAR, 1))] = httpx.Response(200, text="oops")
    result, facts = collect(table)
    assert (result["status"], facts) == ("failed", [])
    assert "not JSON" in result["detail"]


def discover(table: dict, wiki=None, override=None, seen=None) -> dict:
    with httpx.Client(transport=world.transport(table, seen, wiki)) as client:
        return government_meetings.discover(client, world.town_profile(), override)


def page(html: str) -> httpx.Response:
    return httpx.Response(200, content=html.encode(), headers={"content-type": "text/html"})


def test_discovery_confirms_a_platform_linked_from_the_town_website():
    table = {
        world.WEBSITE: page(f'<a href="https://{world.LEGISTAR}.legistar.com/Calendar.aspx">'),
        world.key(legistar.confirm_url(world.LEGISTAR)): httpx.Response(200, json=[{"Id": 1}]),
    }
    found = discover(table)
    assert (found["status"], found["platform"], found["tenant"]) == (
        "detected",
        "legistar",
        world.LEGISTAR,
    )
    assert found["website"] == world.WEBSITE and found["pages_checked"] == [world.WEBSITE]
    assert government_meetings.source_id(found) == "meetings:legistar:exampletown"


def test_discovery_follows_an_agenda_page():
    agendas = "https://www.exampletown.gov/government/agendas"
    table = {
        world.WEBSITE: page('<a href="/government/agendas">Agendas</a><a href="/parks">Parks</a>'),
        agendas: page(f'<a href="https://{world.CIVICCLERK}.portal.civicclerk.com/">Meetings</a>'),
        world.key(civicclerk.confirm_url(world.CIVICCLERK)): httpx.Response(
            200, json={"value": []}
        ),
    }
    seen = []
    found = discover(table, seen=seen)
    assert (found["status"], found["platform"], found["tenant"]) == (
        "detected",
        "civicclerk",
        world.CIVICCLERK,
    )
    assert found["pages_checked"] == [world.WEBSITE, agendas]
    assert "https://www.exampletown.gov/parks" not in seen


def test_discovery_guesses_tenants_and_tolerates_unknown_ones():
    table = {
        world.WEBSITE: page("<p>Welcome</p>"),
        world.key(legistar.confirm_url("exampletown")): httpx.Response(500),
        world.key(civicclerk.confirm_url("exampletown")): httpx.Response(200, json={"value": []}),
    }
    found = discover(table)
    assert (found["status"], found["platform"], found["tenant"]) == (
        "detected",
        "civicclerk",
        "exampletown",
    )
    assert "guessed" in found["detail"]
    nothing = discover({world.WEBSITE: page("<p>Welcome</p>")})
    assert nothing["status"] == "no_platform" and nothing["website"] == world.WEBSITE


def test_discovery_respects_primegov_robots():
    table = {
        world.WEBSITE: page('<a href="https://exampletown.primegov.com/public/portal">'),
        "https://exampletown.primegov.com/robots.txt": httpx.Response(
            200, text="User-agent: *\nDisallow: /"
        ),
    }
    found = discover(table)
    assert (found["status"], found["platform"]) == ("blocked", "primegov")


def test_discovery_records_failures_without_raising():
    unresolved = discover({}, wiki=world.wikidata(label="Elsewhere"))
    assert unresolved["status"] == "unresolved_website" and unresolved["website"] is None
    failed = discover({world.WEBSITE: httpx.Response(503)})
    assert failed["status"] == "failed" and "503" in failed["detail"]
    override = discover({}, override={"platform": "legistar", "tenant": "reviewed"})
    assert (override["status"], override["tenant"]) == ("override", "reviewed")


def test_meeting_stories_keep_their_kind_and_get_a_civic_prompt():
    facts = {
        "title": "City Council decisions: Budget",
        "source_event_id": "3",
        "event_date": "2026-10-28",
        "schedule_text": "Wednesday",
        "venue": "City Hall",
        "source_url": "https://example.gov",
        "kind": "meeting_outcome",
    }
    [story] = stories.collapse([{"source_id": "meetings:legistar:x", "facts": facts}])
    assert story.kind == "meeting_outcome"
    prompt = story_writer.item_prompt({"title": facts["title"], "kind": story.kind})
    assert "what this public body decided" in prompt and "worth going" not in prompt
    event = story_writer.item_prompt({"title": "Lego Club"})
    assert "what happens at this event and why it is worth going" in event
