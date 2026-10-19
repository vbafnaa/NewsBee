"""Snapshot -> queued authoring -> published edition, with no human review step."""

import json
import sqlite3
import threading
from datetime import date

import pytest
from anyio.from_thread import start_blocking_portal

from projects.backend.modules.communities import locations
from projects.backend.modules.editions import drafting, stories
from projects.backend.modules.orchestration import jobs, worker
from projects.backend.shared.model_inference.story_writer import NO_EVENTS_INTRO
from projects.backend.shared.storage import snapshots
from projects.backend.shared.storage.database import SCHEMA_VERSION, connect, initialize
from tests import fakes, library_world
from tests.library_world import LOCATION_ID

TARGET = "projects.backend.modules.editions.drafting"
WINDOW = ("2026-11-01", "2026-11-07")


def author(settings, monkeypatch, **fake):
    requests = fakes.install(monkeypatch, TARGET, **fake)
    with start_blocking_portal() as portal:
        run = portal.call(drafting.author_edition, settings, LOCATION_ID)
    return run, requests


def run_worker(settings, monkeypatch, **fake):
    requests = fakes.install(monkeypatch, TARGET, **fake)
    job = jobs.claim(settings.database, jobs.AUTHOR_KIND)
    assert job is not None, "ingestion should have queued an authoring job"
    # A thread keeps asyncio.run() independent of any caller event loop (e.g. Playwright).
    thread = threading.Thread(target=worker.execute, args=(settings, job))
    thread.start()
    thread.join()
    with connect(settings.database) as database:
        row = database.execute("SELECT * FROM jobs WHERE id = ?", (job["id"],)).fetchone()
    return dict(row), requests


def store_snapshot(settings, count: int, repeat: int = 0) -> str:
    """`count` distinct stories, plus `repeat` extra occurrences of Story Hour 0."""
    initialize(settings.database)
    library_world.onboard(settings.database)

    def event(index: int, title: str, venue: str = "Capitol Hill Branch") -> dict:
        day = 1 + index // 3
        return {
            "source_id": "library:WA0001",
            "source_event_id": f"e{index}",
            "event_date": f"2026-11-0{day}",
            "facts": {
                "source_event_id": f"e{index}",
                "title": title,
                "event_date": f"2026-11-0{day}",
                "schedule_text": f"{date(2026, 11, day):%A}, November {day}, 2026, 10am",
                "venue": venue,
                "room": None,
                "source_url": f"https://www.spl.org/event/{index}",
                "description": f"{title} has free picture books and songs.",
                "branch": "Capitol Hill",
            },
        }

    events = [event(index, f"Story Hour {index}") for index in range(count)]
    events += [event(count + index, "Story hour 0!", "Ballard Branch") for index in range(repeat)]
    with connect(settings.database) as database:
        identity = snapshots.record(database, LOCATION_ID, "job", WINDOW, events, [], "e.json")
        jobs.enqueue_within(database, LOCATION_ID, jobs.AUTHOR_KIND)
    return identity


def hold(*titles):
    def story(data):
        draft = fakes.valid_story(data)
        return {**draft, "summary": "Free raffle."} if data["title"] in titles else draft

    return story


def rate(**overrides):
    """Fake ranking: per-title overrides of the default distinct-category ratings."""

    def ranking(candidates):
        ratings = fakes.valid_ranking(candidates)["ratings"]
        titles = {item["id"]: item["title"] for item in candidates}
        return {"ratings": [{**r, **overrides.get(titles[r["id"]], {})} for r in ratings]}

    return ranking


def headlines(client) -> list[str]:
    items = client.get(f"/api/editions/{LOCATION_ID}").json()["items"]
    return [item["headline"].removeprefix("Don't miss ") for item in items]


def test_ingestion_snapshot_is_authored_and_published(
    client, settings, ingested_event, monkeypatch
):
    ingestion = ingested_event["jobs"][0]["result"]
    snapshot = snapshots.latest(settings.database, LOCATION_ID)
    assert snapshot["id"] == ingestion["snapshot_id"] and snapshot["event_count"] == 1
    assert (snapshot["window_start"], snapshot["window_end"]) == WINDOW
    job, requests = run_worker(settings, monkeypatch)
    assert job["id"] == ingestion["author_job_id"] and job["status"] == "completed"
    assert len(requests) == 4 and {r["model"] for r in requests} == {"qwen3:4b"}
    assert "\nEmail:\n" in requests[3]["prompt"]
    assert requests[0]["options"]["num_gpu"] == 0 and requests[0]["keep_alive"] == "10m"
    assert "\nCandidates:\n" in requests[0]["prompt"]
    story_prompt = requests[1]["prompt"].split("\nStory:\n")[1]
    assert "venue_url" not in story_prompt and "source_url" not in story_prompt
    run = drafting.latest_run(settings.database)
    assert (run.status, run.included, run.held, run.attempted, run.not_attempted) == (
        "completed",
        1,
        0,
        1,
        0,
    )
    assert (run.events, run.stories, run.skipped_for_variety, run.ranking_fallback_ratings) == (
        1,
        1,
        0,
        0,
    )
    assert run.snapshot_id == snapshot["id"] and run.front_fallback is False

    listing = client.get("/api/editions").json()["locations"]
    assert [(item["location_id"], item["edition_id"]) for item in listing] == [
        (LOCATION_ID, run.id)
    ]
    edition = client.get(f"/api/editions/{LOCATION_ID}").json()
    facts = ingested_event["events"][0]["facts"]
    assert edition["headline"] == f"{facts['title']} this week"
    assert edition["intro"] == "Here is what is on around Seattle."
    schedule = facts["schedule_text"].replace(", 2026", "")
    assert edition["items"] == [
        {
            "headline": f"Don't miss {facts['title']}",
            "blurb": f"Join us for {facts['title']}.",
            "when_where": f"When: {schedule}. Where: {facts['venue']}, {facts['room']}.",
            "event_date": "2026-11-03",
            "source_url": facts["source_url"],
            "rank": 1,
        }
    ]
    health = client.get("/api/health").json()
    assert health["latest_edition"]["included"] == 1
    assert health["locations"][0]["latest_edition_id"] == run.id
    page = client.get("/review/editions").text
    assert "No held items." in page and "newsworthiness_v1+story_v1" in page
    assert "Rank 1, score 3" in page
    assert "human review" not in page.lower()
    assert client.post("/review/editions").status_code == 405


def test_fill_to_five_skips_held_items_in_rank_order(client, settings, monkeypatch):
    store_snapshot(settings, 8)
    job, _ = run_worker(settings, monkeypatch, story=hold("Story Hour 0", "Story Hour 2"))
    run = drafting.latest_run(settings.database)
    assert job["status"] == "completed"
    assert (run.included, run.held, run.attempted, run.not_attempted) == (5, 2, 7, 1)
    assert headlines(client) == [f"Story Hour {i}" for i in (1, 3, 4, 5, 6)]
    held = client.get("/review/editions").text.split("Held text (excluded from the edition)")[1]
    assert "Story Hour 0" in held and "summary:unsupported_claim_word:raffle" in held


def test_newsworthiness_orders_items_by_weighted_rubric(client, settings, monkeypatch):
    store_snapshot(settings, 4)
    ranking = rate(
        **{
            "Story Hour 3": {"civic": 2},  # 3*2 + 2 + 1 = 9
            "Story Hour 2": {"appeal": 3},  # 2*3 + 1 = 7
            "Story Hour 1": {"special": 3},  # 2 + 3 = 5
        }
    )
    run, _ = author(settings, monkeypatch, ranking=ranking)
    assert headlines(client) == ["Story Hour 3", "Story Hour 2", "Story Hour 1", "Story Hour 0"]
    edition = client.get(f"/api/editions/{LOCATION_ID}").json()
    assert edition["headline"] == "Story Hour 3 this week"


def test_one_item_per_category(client, settings, monkeypatch):
    store_snapshot(settings, 4)
    same = {"category": "early_learning"}
    ranking = rate(**{f"Story Hour {i}": same for i in range(3)})
    run, _ = author(settings, monkeypatch, ranking=ranking)
    assert headlines(client) == ["Story Hour 0", "Story Hour 3"]
    assert (run.included, run.skipped_for_variety, run.not_attempted) == (2, 2, 2)


def test_repeated_events_collapse_into_one_story(client, settings, monkeypatch):
    store_snapshot(settings, 2, repeat=5)
    run, requests = author(settings, monkeypatch)
    assert (run.events, run.stories, run.included) == (7, 2, 2)
    candidates = json.loads(requests[0]["prompt"].split("\nCandidates:\n")[1])
    assert [c["occurrences"] for c in candidates] == [6, 1]
    assert candidates[0]["venues"] == ["Ballard Branch", "Capitol Hill Branch"]
    item = client.get(f"/api/editions/{LOCATION_ID}").json()["items"][1]
    assert item["headline"] == "Don't miss Story Hour 0"
    assert item["when_where"] == (
        "When and where: Sunday, November 1, 10am at Ballard Branch; "
        "Sunday, November 1, 10am at Capitol Hill Branch; "
        "Monday, November 2, 10am at Ballard Branch; "
        "Monday, November 2, 10am at Ballard Branch; plus 2 more."
    )
    assert item["source_url"] == "https://www.spl.org/event/2"


def test_ranking_failure_falls_back_to_rules(client, settings, monkeypatch):
    store_snapshot(settings, 3)
    run, _ = author(settings, monkeypatch, ranking=lambda _: "not json")
    assert (run.status, run.included, run.ranking_fallback_ratings) == ("completed", 3, 3)
    assert headlines(client) == ["Story Hour 0", "Story Hour 1", "Story Hour 2"]
    assert "rated by rule" in client.get("/review/editions").text


def test_held_draft_gets_one_retry_with_errors_fed_back(client, settings, monkeypatch):
    store_snapshot(settings, 1)
    calls = []

    def story(data):
        calls.append(data["title"])
        draft = fakes.valid_story(data)
        return {**draft, "summary": "Free raffle."} if len(calls) == 1 else draft

    run, requests = author(settings, monkeypatch, story=story)
    assert (run.included, run.held, len(calls)) == (1, 0, 2)
    retry = requests[2]["prompt"]
    assert "Your previous draft was rejected" in retry and "Free raffle." in retry
    assert "summary:unsupported_claim_word:raffle" in retry
    page = client.get("/review/editions").text
    assert "Passed on retry after: summary:unsupported_claim_word:raffle" in page


def test_only_ten_random_stories_are_ranked(client, settings, monkeypatch):
    store_snapshot(settings, 14)
    run, requests = author(settings, monkeypatch)
    ranked = json.loads(requests[0]["prompt"].split("\nCandidates:\n")[1])
    assert (run.events, run.stories, run.ranked, len(ranked)) == (14, 14, 10, 10)
    assert run.not_attempted == 10 - run.attempted
    assert [c["title"] for c in ranked] != [f"Story Hour {i}" for i in range(10)]
    with connect(settings.database) as database:
        snapshot = database.execute("SELECT id FROM location_snapshots").fetchone()["id"]
    events = snapshots.events(settings.database, snapshot)
    first = [s.title for s in drafting.sample(stories.collapse(events), snapshot)]
    assert first == [s.title for s in drafting.sample(stories.collapse(events), snapshot)]
    assert "Ranked (random sample of at most 10 stories): 10" in client.get("/review/editions").text


def test_attempts_are_capped_and_edition_still_publishes(client, settings, monkeypatch):
    assert (drafting.MAX_ENTRIES, drafting.MAX_ATTEMPTS) == (5, 10)
    store_snapshot(settings, 12)
    titles = [f"Story Hour {i}" for i in range(12)]
    _, requests = run_worker(settings, monkeypatch, story=hold(*titles))
    run = drafting.latest_run(settings.database)
    assert (run.status, run.included, run.held, run.attempted, run.not_attempted) == (
        "completed",
        0,
        10,
        10,
        0,
    )
    assert len(requests) == 21  # 1 ranking batch + 10 items x (draft + one retry)
    edition = client.get(f"/api/editions/{LOCATION_ID}").json()
    assert (edition["headline"], edition["intro"], edition["items"]) == (
        "Seattle this week: Nov 1\u20137",
        NO_EVENTS_INTRO,
        [],
    )


def test_empty_snapshot_publishes_without_the_model(client, settings, monkeypatch):
    store_snapshot(settings, 0)
    job, requests = run_worker(settings, monkeypatch, installed="other:model")
    assert job["status"] == "completed" and requests == []
    edition = client.get(f"/api/editions/{LOCATION_ID}").json()
    assert edition["intro"] == NO_EVENTS_INTRO and edition["items"] == []
    assert edition["headline"] == "Seattle this week: Nov 1\u20137"


def test_model_unavailable_is_retried_and_publishes_nothing(client, settings, monkeypatch):
    store_snapshot(settings, 1)
    job, requests = run_worker(settings, monkeypatch, installed="other:model")
    assert (job["status"], job["attempts"]) == ("pending", 1)
    assert "ModelNotReady" in job["error"] and "pull qwen3:4b" in job["error"]
    assert requests == [] and drafting.latest_run(settings.database) is None
    assert client.get(f"/api/editions/{LOCATION_ID}").json() == {"detail": "No edition yet"}


def test_unexpected_failure_fails_job_and_keeps_audit(client, settings, monkeypatch):
    store_snapshot(settings, 1)

    async def explode(*_):
        raise RuntimeError("fixture crash")

    monkeypatch.setattr(drafting.story_writer, "write_item", explode)
    job, _ = run_worker(settings, monkeypatch)
    assert job["status"] == "failed" and "fixture crash" in job["error"]
    latest = drafting.latest_run(settings.database)
    assert latest.status == "failed" and latest.front_fallback is None
    assert "Run error: RuntimeError: fixture crash" in client.get("/review/editions").text
    assert client.get(f"/api/editions/{LOCATION_ID}").status_code == 404


def test_each_snapshot_is_published_once(settings, monkeypatch):
    first = store_snapshot(settings, 1)
    run, requests = author(settings, monkeypatch)
    again, repeat = author(settings, monkeypatch)
    assert again.id == run.id and repeat == [] and run.snapshot_id == first
    with connect(settings.database) as database:
        second = snapshots.record(database, LOCATION_ID, "job2", WINDOW, [], [], "e.json")
    newer, _ = author(settings, monkeypatch)
    assert newer.id != run.id and newer.snapshot_id == second


def test_authoring_dedupes_only_pending_jobs(settings):
    store_snapshot(settings, 0)
    pending = jobs.enqueue(settings.database, LOCATION_ID, jobs.AUTHOR_KIND)
    with connect(settings.database) as database:
        assert jobs.enqueue_within(database, LOCATION_ID, jobs.AUTHOR_KIND) == pending
    assert jobs.claim(settings.database, jobs.AUTHOR_KIND)["id"] == pending
    assert jobs.enqueue(settings.database, LOCATION_ID, jobs.AUTHOR_KIND) != pending
    with pytest.raises(ValueError, match="Unknown job kind"):
        jobs.enqueue(settings.database, LOCATION_ID, "publish")


def test_no_snapshot_fails_without_retry(settings, monkeypatch):
    initialize(settings.database)
    library_world.onboard(settings.database)
    jobs.enqueue(settings.database, LOCATION_ID, jobs.AUTHOR_KIND)
    job, _ = run_worker(settings, monkeypatch)
    assert job["status"] == "failed" and "run ingest-events first" in job["error"]


@pytest.mark.parametrize("outcome", ["injected-claim", "http-error"])
def test_held_items_are_excluded_and_explained(client, settings, monkeypatch, outcome):
    store_snapshot(settings, 1)
    fake = (
        {"story": lambda s: {**fakes.valid_story(s), "summary": "<b>Free</b> raffle for all."}}
        if outcome == "injected-claim"
        else {"status": 500}
    )
    run, requests = author(settings, monkeypatch, **fake)
    assert (run.status, run.included, run.held, run.front_fallback) == ("completed", 0, 1, True)
    assert len(requests) == (3 if outcome == "injected-claim" else 2)
    page = client.get("/review/editions").text
    edition, held = page.split("Held text (excluded from the edition)")
    assert NO_EVENTS_INTRO in edition
    assert "Story Hour 0" in held
    if outcome == "injected-claim":
        assert "summary:unsupported_claim_word:raffle" in held
        assert "&lt;b&gt;Free&lt;/b&gt;" in held and "<b>Free</b>" not in page
    else:
        assert "Generation error: HTTPStatusError" in held
    assert client.get(f"/api/editions/{LOCATION_ID}").json()["items"] == []


def test_held_front_uses_fixed_fallback(client, settings, monkeypatch):
    store_snapshot(settings, 1)
    run, _ = author(
        settings,
        monkeypatch,
        edition_front=lambda _: {"headline": "<i>Free</i> fun", "intro": "Join us online."},
    )
    assert (run.included, run.front_fallback) == (1, True)
    edition = client.get(f"/api/editions/{LOCATION_ID}").json()
    assert edition["headline"] == "Seattle this week: Nov 1\u20137"
    page = client.get("/review/editions").text
    assert "Rejected headline: &lt;i&gt;Free&lt;/i&gt; fun" in page
    assert "intro:unsupported_claim_word:online" in page and "<i>Free</i>" not in page


def test_configured_model_overrides_default(settings, monkeypatch):
    store_snapshot(settings, 1)
    settings.ollama_model = "qwen3:1.7b"
    run, requests = author(settings, monkeypatch, installed="qwen3:1.7b")
    assert run.model == "qwen3:1.7b" and requests[0]["model"] == "qwen3:1.7b"


def test_empty_and_unavailable_console_states(client, monkeypatch, caplog):
    assert "No editions yet." in client.get("/review/editions").text
    assert "/review/editions" in client.get("/review").text

    def fail(_):
        raise sqlite3.OperationalError("fixture database failure")

    monkeypatch.setattr("projects.backend.api.routes.console.inspect_editions", fail)
    response = client.get("/review/editions")
    assert response.status_code == 503
    assert "Edition audit unavailable." in response.text
    assert "Edition audit unavailable" in caplog.text


def test_removing_a_location_deletes_all_its_data(client, settings, monkeypatch):
    store_snapshot(settings, 2)
    author(settings, monkeypatch)
    with connect(settings.database) as database:
        database.execute(
            "INSERT INTO source_events (source_id, source_event_id, event_date, community_id, "
            "facts_json, retrieved_at, evidence_path) VALUES ('s', 'e', '2026-11-01', ?, '{}', 0, "
            "'x')",
            (LOCATION_ID,),
        )
    evidence = settings.evidence_dir / LOCATION_ID
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "e.json").write_text("{}")
    running = jobs.enqueue(settings.database, LOCATION_ID, jobs.AUTHOR_KIND)
    assert jobs.claim(settings.database, jobs.AUTHOR_KIND)["id"] == running
    with pytest.raises(locations.LocationBusy):
        locations.remove(settings.database, settings.evidence_dir, LOCATION_ID)
    with connect(settings.database) as database:
        database.execute("UPDATE jobs SET status = 'completed' WHERE id = ?", (running,))

    counts = locations.remove(settings.database, settings.evidence_dir, LOCATION_ID)
    assert counts == {
        "email_deliveries": 0,
        "edition_entries": 2,
        "editions": 1,
        "snapshot_events": 2,
        "snapshots": 1,
        "events": 1,
        "jobs": 1,
        "locations": 1,
        "evidence_files": 1,
    }
    assert not evidence.exists()
    with connect(settings.database) as database:
        for table in ("jobs", "edition_drafts", "location_snapshots", "snapshot_events"):
            assert database.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    assert client.get("/api/editions").json()["locations"] == []
    with pytest.raises(LookupError):
        locations.remove(settings.database, settings.evidence_dir, LOCATION_ID)


def test_v5_database_gains_snapshots_and_keeps_editions(tmp_path):
    path = tmp_path / "v5.sqlite3"
    initialize(path)
    with connect(path) as database:
        database.execute("DROP TABLE snapshot_events")
        database.execute("DROP TABLE location_snapshots")
        database.execute("ALTER TABLE edition_drafts DROP COLUMN snapshot_id")
        database.execute(
            "INSERT INTO edition_drafts (id, community_id, window_start, window_end, model, "
            "validation_policy, status, created_at) VALUES ('old', 'c', '2026-01-01', "
            "'2026-01-07', 'm', 'news_blurb_v1', 'completed', 0)"
        )
        database.execute("PRAGMA user_version = 5")
    initialize(path)
    with connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 7
        row = database.execute("SELECT id, snapshot_id FROM edition_drafts").fetchone()
        assert (row["id"], row["snapshot_id"]) == ("old", None)
        assert database.execute("SELECT COUNT(*) FROM location_snapshots").fetchone()[0] == 0


def test_v3_draft_tables_migrate(tmp_path):
    path = tmp_path / "v3.sqlite3"
    initialize(path)
    with connect(path) as database:
        database.execute("DROP TABLE edition_draft_entries")
        database.execute(
            "CREATE TABLE edition_draft_entries (edition_id TEXT NOT NULL, position INTEGER "
            "NOT NULL, source_id TEXT NOT NULL, source_event_id TEXT NOT NULL, event_date TEXT "
            "NOT NULL, disposition TEXT NOT NULL CHECK (disposition IN ('held', "
            "'template_validated')), result_json TEXT NOT NULL, PRIMARY KEY (edition_id, position))"
        )
        database.execute(
            "INSERT INTO edition_drafts (id, community_id, window_start, window_end, model, "
            "validation_policy, status, created_at) VALUES ('old', 'c', '2026-01-01', "
            "'2026-01-07', 'm', 'exact_fact_template_v1', 'completed', 0)"
        )
        database.execute(
            "INSERT INTO edition_draft_entries VALUES "
            "('old', 0, 's', 'e', '2026-01-02', 'template_validated', '{}')"
        )
        database.execute("PRAGMA user_version = 3")
    initialize(path)
    with connect(path) as database:
        assert database.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        # v5 made events per location, so earlier single-source drafts are dropped.
        assert database.execute("SELECT COUNT(*) FROM edition_draft_entries").fetchone()[0] == 0
        assert database.execute("SELECT COUNT(*) FROM edition_drafts").fetchone()[0] == 0
