"""The private POC exit gate, offline: two communities, two connectors, three weeks."""

import json
import re
from datetime import date, timedelta

import httpx
import pytest
from anyio.from_thread import start_blocking_portal

from projects.backend.modules.communities import locations
from projects.backend.modules.editions import drafting, stories
from projects.backend.modules.editorial.corrections import withdrawals
from projects.backend.modules.orchestration import jobs, worker
from projects.backend.modules.source_connectors.pipelines.events import ingest, window
from projects.backend.shared.storage import snapshots
from projects.backend.shared.storage.database import connect, initialize
from tests import fakes, library_world, meetings_world
from tests.integration.test_edition_publishing import author, store_snapshot

pytestmark = pytest.mark.critical
TARGET = "projects.backend.modules.editions.drafting"


def shift_dates(value: str, days: int) -> str:
    return re.sub(
        r"\d{4}-\d{2}-\d{2}",
        lambda match: (date.fromisoformat(match[0]) + timedelta(days=days)).isoformat(),
        value,
    )


def test_two_communities_two_connectors_three_weekly_cycles(settings, monkeypatch):
    initialize(settings.database)
    town_ids = ("seattle-wa", "exampletown-wa")
    for identity in town_ids:
        profile = library_world.profile()
        profile.update(id=identity, name=f"{identity.split('-')[0].title()}, WA")
        profile["systems"] = profile["systems"][:1]
        profile["government"] = meetings_world.government()
        locations.save(settings.database, profile)
    requests = fakes.install(monkeypatch, TARGET)
    edition_ids = set()
    for week in range(3):
        today = library_world.TODAY + timedelta(weeks=week)
        table = library_world.routes()
        table.update(meetings_world.legistar_routes())
        shifted = {}
        for url, response in table.items():
            content = shift_dates(response.content.decode(), week * 7)
            if url == library_world.FEED_URL:
                for day in (3, 4):
                    old = date(2026, 11, day)
                    new = old + timedelta(weeks=week)
                    content = content.replace(old.strftime("%Y/%m/%d"), new.strftime("%Y/%m/%d"))
                    content = content.replace(f"November {day},", f"November {new.day},")
            shifted[shift_dates(url, week * 7)] = httpx.Response(
                response.status_code, content=content
            )
        for identity in town_ids:
            jobs.enqueue(settings.database, identity)
            job = jobs.claim(settings.database, jobs.JOB_KIND)
            with httpx.Client(transport=meetings_world.transport(shifted)) as client:
                ingest(settings, job, client, today)
            # Restart the storage layer between acquisition and publication.
            initialize(settings.database)
            job = jobs.claim(settings.database, jobs.AUTHOR_KIND)
            worker.execute(settings, job)
            edition = drafting.latest_published(settings.database, identity)
            assert edition.location_id == identity
            assert (edition.window_start, edition.window_end) == window(today)
            assert len(edition.items) >= 2
            assert {"event", "meeting_preview"} <= {item.kind for item in edition.items}
            assert all(item.source_url.startswith("https://") for item in edition.items)
            assert all(item.source_name != "Local source" for item in edition.items)
            edition_ids.add(edition.id)
            snapshot = snapshots.latest(settings.database, identity)
            evidence = settings.data_dir / snapshot["evidence_path"]
            assert evidence.is_file()
            assert len(json.loads(evidence.read_text())["events"]) >= len(edition.items)
            with start_blocking_portal() as portal:
                repeated = portal.call(drafting.author_edition, settings, identity)
            assert repeated.id == edition.id
    assert len(edition_ids) == 6
    assert requests


def test_unchanged_prose_reused_but_changed_facts_and_policy_invalidate(settings, monkeypatch):
    first = store_snapshot(settings, 5)
    run, requests = author(settings, monkeypatch)
    assert run.included == 5 and len(requests) == 8
    events = snapshots.events(settings.database, first)

    def again():
        with connect(settings.database) as database:
            snapshots.record(
                database,
                library_world.LOCATION_ID,
                "next",
                ("2026-11-01", "2026-11-07"),
                events,
                [],
                "e.json",
            )
        return author(
            settings, monkeypatch, installed=settings.ollama_model or drafting.DEFAULT_MODEL
        )[1]

    repeated = again()
    assert len(repeated) == 3
    assert not any("\nStory:\n" in request["prompt"] for request in repeated)
    events[0]["facts"]["description"] += " Read together."
    assert len(again()) == 4
    monkeypatch.setattr(drafting, "VALIDATION_POLICY", drafting.VALIDATION_POLICY + ":changed")
    assert len(again()) == 8
    settings.ollama_model = "qwen3:1.7b"
    assert len(again()) == 8


@pytest.mark.parametrize("case", ["sensitive", "missing-link", "missing-context"])
def test_risky_or_unsupported_story_held_before_inference(settings, monkeypatch, case):
    identity = store_snapshot(settings, 1)
    with connect(settings.database) as database:
        event = snapshots.events(settings.database, identity)[0]
        facts = event["facts"]
        if case == "sensitive":
            facts["description"] = "A named resident was arrested after an allegation."
        elif case == "missing-link":
            facts["source_url"] = "javascript:alert(1)"
        else:
            facts["description"] = None
        database.execute(
            "UPDATE snapshot_events SET facts_json = ? WHERE snapshot_id = ?",
            (json.dumps(facts), identity),
        )
    run, requests = author(settings, monkeypatch)
    assert (run.included, run.held) == (0, 1)
    assert len(requests) == 1  # rank only; no prose generation for ineligible material
    assert drafting.latest_published(settings.database, library_world.LOCATION_ID).items == []


def test_practical_support_events_are_not_excluded_for_sensitive_topics(settings, monkeypatch):
    identity = store_snapshot(settings, 3)
    titles = [
        "Eviction prevention workshop",
        "Domestic violence support group",
        "Suicide prevention training",
    ]
    events = snapshots.events(settings.database, identity)
    with connect(settings.database) as database:
        for position, (event, title) in enumerate(zip(events, titles, strict=True)):
            facts = event["facts"]
            facts.update(title=title, description=f"{title} offers practical help.")
            database.execute(
                "UPDATE snapshot_events SET facts_json = ? WHERE snapshot_id = ? AND position = ?",
                (json.dumps(facts), identity, position),
            )
    run, _ = author(settings, monkeypatch)
    assert (run.included, run.held) == (3, 0)


def test_withdrawal_visible_and_cannot_reappear_from_cache(client, settings, monkeypatch):
    identity = store_snapshot(settings, 1)
    run, _ = author(settings, monkeypatch)
    original = drafting.latest_published(settings.database, library_world.LOCATION_ID)
    item = original.items[0]
    reason = "The source listing was incorrect; this story has been withdrawn."
    withdrawals.withdraw(settings.database, run.id, item.story_id, reason)
    withdrawals.withdraw(settings.database, run.id, item.story_id, reason)
    with pytest.raises(ValueError, match="cannot be overwritten"):
        withdrawals.withdraw(settings.database, run.id, item.story_id, "A different explanation.")
    corrected = client.get(f"/api/editions/{library_world.LOCATION_ID}").json()
    assert corrected["items"] == []
    assert corrected["headline"] != original.headline
    assert [notice["reason"] for notice in corrected["corrections"]] == [reason]
    assert "corrected" in drafting.email_content(settings.database, run.id)["intro"]
    # The original audit remains inspectable; the cache does not bypass the withdrawal.
    assert drafting.inspect_editions(settings.database)["latest"]["included"]
    with connect(settings.database) as database:
        snapshots.record(
            database,
            library_world.LOCATION_ID,
            "next",
            ("2026-11-01", "2026-11-07"),
            snapshots.events(settings.database, identity),
            [],
            "e.json",
        )
    next_run, requests = author(settings, monkeypatch)
    assert (next_run.included, next_run.held, len(requests)) == (0, 1, 1)
    assert "previously_withdrawn" in str(drafting.inspect_editions(settings.database))
    events = snapshots.events(settings.database, identity)
    events[0]["facts"]["title"] = "Renamed source listing"
    with connect(settings.database) as database:
        snapshots.record(
            database,
            library_world.LOCATION_ID,
            "renamed",
            ("2026-11-01", "2026-11-07"),
            events,
            [],
            "e.json",
        )
    renamed, requests = author(settings, monkeypatch)
    assert (renamed.included, renamed.held, len(requests)) == (0, 1, 1)


def test_interrupted_authoring_reuses_checked_progress(settings, monkeypatch):
    store_snapshot(settings, 1)
    original = drafting.story_writer.write_front

    async def crash(*args):
        raise RuntimeError("simulated process interruption")

    monkeypatch.setattr(drafting.story_writer, "write_front", crash)
    with pytest.raises(RuntimeError, match="interruption"):
        author(settings, monkeypatch)
    assert drafting.latest_run(settings.database).status == "failed"
    initialize(settings.database)
    monkeypatch.setattr(drafting.story_writer, "write_front", original)
    run, requests = author(settings, monkeypatch)
    assert run.included == 1
    assert not any("\nStory:\n" in request["prompt"] for request in requests)


def test_full_pool_ranking_preserves_council_and_meeting_identity():
    def event(title, kind, day):
        return {
            "source_id": "meetings:legistar:x",
            "facts": {
                "title": title,
                "kind": kind,
                "event_date": day,
                "source_event_id": day,
                "schedule_text": day,
                "venue": "City Hall",
                "source_url": "https://example.org",
                "description": "A public meeting.",
                "body": title,
            },
        }

    pool = [event(f"Parks Board {i}", "meeting_preview", "2026-11-02") for i in range(30)]
    pool += [
        event("City Council", "meeting_preview", "2026-11-03"),
        event("City Council", "meeting_outcome", "2026-10-28"),
        event("City Council", "meeting_preview", "2026-11-06"),
    ]
    collapsed = stories.collapse(pool)
    council = [story for story in collapsed if story.title == "City Council"]
    assert len(council) == 3
    shortlist, _ = drafting.shortlist(collapsed)
    assert {story.id for story in council} <= {story.id for story in shortlist}


def test_civic_coverage_survives_popularity_scores_and_shared_categories(settings, monkeypatch):
    identity = store_snapshot(settings, 3)
    with connect(settings.database) as database:
        events = snapshots.events(settings.database, identity)
        for position, kind in enumerate(("meeting_preview", "meeting_outcome")):
            facts = events[position]["facts"]
            facts["kind"] = kind
            database.execute(
                "UPDATE snapshot_events SET facts_json = ? WHERE snapshot_id = ? AND position = ?",
                (json.dumps(facts), identity, position),
            )

    def ranking(candidates):
        return {
            "ratings": [
                {
                    "id": item["id"],
                    "category": "civic_and_practical",
                    "civic": 3 if item["title"] == "Story Hour 2" else 0,
                    "appeal": 3,
                    "special": 3,
                }
                for item in candidates
            ]
        }

    run, _ = author(settings, monkeypatch, ranking=ranking)
    edition = drafting.latest_published(settings.database, library_world.LOCATION_ID)
    assert run.included == 3
    assert [item.kind for item in edition.items] == [
        "meeting_preview",
        "meeting_outcome",
        "event",
    ]
