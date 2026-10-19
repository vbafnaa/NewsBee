import json
import sqlite3

import pytest

from projects.backend.modules.orchestration import jobs
from projects.backend.shared.storage.database import connect


def test_empty_inspection_is_not_a_failure(client):
    response = client.get("/review/ingestion")
    assert response.status_code == 200
    assert "No retained events yet." in response.text
    assert "No ingestion jobs yet." in response.text
    assert "Redistribution permission is unresolved." in response.text
    assert "/review/ingestion" in client.get("/review").text
    assert client.post("/review/ingestion").status_code == 405


def test_inspection_reads_pipeline_output_without_mutation(client, settings, ingested_event):
    before = jobs.inspect(settings.database)
    response = client.get("/review/ingestion")
    assert response.status_code == 200
    event = ingested_event["events"][0]
    assert event["facts"]["title"] in response.text
    assert event["facts"]["source_url"] in response.text
    assert event["retrieved_at"] in response.text
    assert "spl-capitol-hill: completed" in response.text
    assert "Events retained" in response.text
    assert "PRIVATE_DESCRIPTION" not in response.text
    assert "do-not-save" not in response.text
    assert jobs.inspect(settings.database) == before


@pytest.mark.parametrize("status", ["pending", "running", "failed", "completed"])
def test_job_states_and_errors_are_visible_and_escaped(client, settings, status):
    with connect(settings.database) as database:
        database.execute(
            """INSERT INTO jobs
            (id, kind, source_id, status, created_at, attempts, error)
            VALUES ('fixture-job', ?, 'spl-capitol-hill', ?, 0, 1, ?)""",
            (jobs.JOB_KIND, status, "<script>error</script>"),
        )
    response = client.get("/review/ingestion")
    assert f"spl-capitol-hill: {status}" in response.text
    assert "1970-01-01T00:00:00+00:00" in response.text
    assert "Not recorded" in response.text
    assert "&lt;script&gt;error&lt;/script&gt;" in response.text
    assert "<script>error</script>" not in response.text


def test_event_text_is_escaped_and_unsafe_links_are_not_clickable(client, settings, ingested_event):
    facts = ingested_event["events"][0]["facts"]
    facts["title"] = "<script>event</script>"
    facts["source_url"] = "javascript:alert(1)"
    with connect(settings.database) as database:
        database.execute("UPDATE source_events SET facts_json = ?", (json.dumps(facts),))
    response = client.get("/review/ingestion")
    assert "&lt;script&gt;event&lt;/script&gt;" in response.text
    assert "javascript:" not in response.text
    assert "Source link unavailable" in response.text


def test_inspection_reports_storage_failure_instead_of_empty_success(client, monkeypatch, caplog):
    def fail(_):
        raise sqlite3.OperationalError("fixture database failure")

    monkeypatch.setattr("projects.backend.api.routes.console.inspect", fail)
    response = client.get("/review/ingestion")
    assert response.status_code == 503
    assert "Ingestion inspection unavailable." in response.text
    assert "No retained events yet." not in response.text
    assert "Ingestion inspection unavailable" in caplog.text


def test_inspection_respects_existing_limits(client, settings, ingested_event):
    event = ingested_event["events"][0]
    with connect(settings.database) as database:
        for index in range(205):
            database.execute(
                "INSERT INTO jobs (id, kind, source_id, status, created_at) "
                "VALUES (?, ?, 'spl-capitol-hill', 'failed', ?)",
                (f"bounded-job-{index}", jobs.JOB_KIND, index + 1),
            )
            database.execute(
                "INSERT INTO source_events VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    event["source_id"],
                    f"bounded-event-{index}",
                    event["event_date"],
                    event["community_id"],
                    json.dumps(event["facts"]),
                    event["retrieved_at"],
                    event["evidence_path"],
                ),
            )
    response = client.get("/review/ingestion")
    assert response.status_code == 200
    assert "200 events shown" in response.text
    assert response.text.count("Job: ") == 20
