"""Email previews: sent automatically on publish, retried per subscriber, visible in health."""

import json
import smtplib

import pytest

from projects.backend.modules.email_previews import delivery
from projects.backend.modules.orchestration import jobs, worker
from projects.backend.shared.storage.database import connect
from tests.integration.test_edition_publishing import run_worker, store_snapshot
from tests.library_world import LOCATION_ID

READERS = ["ana@reader.test", "ben@reader.test"]
pytestmark = pytest.mark.critical


class Mailbox:
    """Stands in for Mailpit: records messages and rejects chosen addresses."""

    def __init__(self):
        self.messages = []
        self.rejected: set[str] = set()
        self.offline = False

    def smtp(self, host, port, timeout):
        assert host == "127.0.0.1" and port == 1025
        if self.offline:
            raise ConnectionRefusedError("Mailpit fixture offline")
        mailbox = self

        class Connection:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def send_message(self, message):
                if message["To"] in mailbox.rejected:
                    raise smtplib.SMTPRecipientsRefused({message["To"]: (550, b"fixture")})
                mailbox.messages.append(message)

        return Connection()

    def recipients(self) -> list[str]:
        return [message["To"] for message in self.messages]


@pytest.fixture
def mailbox(settings, monkeypatch):
    box = Mailbox()
    monkeypatch.setattr(f"{delivery.__name__}.smtplib.SMTP", box.smtp)
    subscribe(settings, {LOCATION_ID: READERS})
    return box


def subscribe(settings, locations):
    settings.subscribers_file.write_text(json.dumps({"locations": locations}))


def publish(settings, monkeypatch, **fake):
    store_snapshot(settings, 2)
    job, requests = run_worker(settings, monkeypatch, **fake)
    assert job["status"] == "completed"
    return job, requests


def send_job(settings) -> dict:
    """Run the queued email job immediately, ignoring retry backoff."""
    with connect(settings.database) as database:
        database.execute("UPDATE jobs SET available_at = 0 WHERE kind = ?", (jobs.EMAIL_KIND,))
    job = jobs.claim(settings.database, jobs.EMAIL_KIND)
    assert job is not None, "an email job should be queued"
    worker.execute(settings, job)
    with connect(settings.database) as database:
        return dict(database.execute("SELECT * FROM jobs WHERE id = ?", (job["id"],)).fetchone())


def email_health(client) -> list[dict]:
    return client.get("/api/health").json()["email_deliveries"]


def test_publishing_emails_a_preview_to_each_subscriber(client, settings, monkeypatch, mailbox):
    job, requests = publish(settings, monkeypatch)
    edition_id = json.loads(job["result_json"])["edition_id"]
    assert "\nEmail:\n" in requests[-1]["prompt"]
    assert email_health(client) == [
        {
            "edition_id": edition_id,
            "location_id": LOCATION_ID,
            "sent": 0,
            "pending": 2,
            "failed": 0,
            "errors": [],
        }
    ]

    assert send_job(settings)["status"] == "completed"
    assert mailbox.recipients() == READERS
    edition = client.get(f"/api/editions/{LOCATION_ID}").json()
    message = mailbox.messages[0]
    assert message["Subject"] == edition["headline"]
    assert message["X-Newsbee-Edition"] == edition_id
    text = message.get_body(("plain",)).get_content()
    html = message.get_body(("html",)).get_content()
    link = f"http://127.0.0.1:4321/?location={LOCATION_ID}"
    assert edition["intro"] in text and "Find out what is on around Seattle this week." in text
    assert f"Read the full Seattle, WA edition: {link}" in text and f'href="{link}"' in html
    assert "Story Hour" not in text.split(edition["intro"])[1], "items stay on the website"
    health = email_health(client)[0]
    assert (health["sent"], health["pending"], health["failed"]) == (2, 0, 0)
    assert client.get("/review/editions").status_code == 200


def test_failed_subscriber_is_retried_without_resending_others(
    client, settings, monkeypatch, mailbox
):
    publish(settings, monkeypatch)
    mailbox.rejected = {READERS[1]}
    job = send_job(settings)
    assert job["status"] == "pending" and "1 of 2 previews not sent" in job["error"]
    health = email_health(client)[0]
    assert (health["sent"], health["failed"]) == (1, 1)
    assert health["errors"][0].startswith(f"{READERS[1]}: SMTPRecipientsRefused")
    assert client.get(f"/api/editions/{LOCATION_ID}").status_code == 200, "edition stays up"

    mailbox.rejected = set()
    assert send_job(settings)["status"] == "completed"
    assert mailbox.recipients() == READERS
    health = email_health(client)[0]
    assert (health["sent"], health["failed"], health["errors"]) == (2, 0, [])


def test_mail_sink_outage_retries_then_fails_and_is_visible(client, settings, monkeypatch, mailbox):
    publish(settings, monkeypatch)
    mailbox.offline = True
    statuses = [send_job(settings)["status"] for _ in range(jobs.MAX_ATTEMPTS)]
    assert statuses == ["pending", "pending", "failed"]
    health = email_health(client)[0]
    assert (health["sent"], health["failed"]) == (0, 2)
    assert "ConnectionRefusedError: Mailpit fixture offline" in health["errors"][0]
    with connect(settings.database) as database:
        attempts = {row[0] for row in database.execute("SELECT attempts FROM email_deliveries")}
    assert attempts == {jobs.MAX_ATTEMPTS}


def test_held_email_blurb_uses_fixed_fallback(client, settings, monkeypatch, mailbox):
    publish(settings, monkeypatch, email=lambda _: {"blurb": "Win a free raffle prize online!"})
    send_job(settings)
    text = mailbox.messages[0].get_body(("plain",)).get_content()
    assert "See what is happening around Seattle this week in the new edition." in text
    assert "raffle" not in text
    run = client.get("/api/health").json()["latest_edition"]
    assert run["email_fallback"] is True and run["front_fallback"] is False
    audit = client.get("/review/editions").text
    assert "Edition email" in audit and "blurb:unsupported_claim_word" in audit


def test_previews_are_not_duplicated_and_new_edition_supersedes(settings, monkeypatch, mailbox):
    job, _ = publish(settings, monkeypatch)
    first = json.loads(job["result_json"])["edition_id"]
    assert delivery.queue(settings, LOCATION_ID, first) == 0
    with connect(settings.database) as database:
        queued = database.execute(
            "SELECT COUNT(*) FROM jobs WHERE kind = ? AND status = 'pending'", (jobs.EMAIL_KIND,)
        ).fetchone()[0]
    assert queued == 1

    store_snapshot(settings, 1)
    second = json.loads(run_worker(settings, monkeypatch)[0]["result_json"])["edition_id"]
    assert second != first
    assert send_job(settings)["status"] == "completed"
    assert [m["X-Newsbee-Edition"] for m in mailbox.messages] == [second, second]
    with connect(settings.database) as database:
        statuses = dict(
            database.execute(
                "SELECT edition_id, GROUP_CONCAT(DISTINCT status) FROM email_deliveries "
                "GROUP BY edition_id"
            ).fetchall()
        )
    assert statuses == {first: "superseded", second: "sent"}


def test_location_without_subscribers_queues_no_email(client, settings, monkeypatch, mailbox):
    subscribe(settings, {"elsewhere-wa": READERS})
    publish(settings, monkeypatch)
    assert jobs.claim(settings.database, jobs.EMAIL_KIND) is None
    assert email_health(client) == []


@pytest.mark.parametrize(
    "content",
    [
        "not json",
        json.dumps({"locations": []}),
        json.dumps({"locations": {LOCATION_ID: ["no-at-sign"]}}),
        json.dumps({"locations": {LOCATION_ID: ["a@b.test\nBcc: x@y.test"]}}),
    ],
)
def test_invalid_subscriber_file_fails_authoring_job(settings, monkeypatch, content):
    settings.subscribers_file.write_text(content)
    store_snapshot(settings, 1)
    job, _ = run_worker(settings, monkeypatch)
    assert job["status"] == "failed"
    assert jobs.claim(settings.database, jobs.EMAIL_KIND) is None


def test_location_removal_deletes_deliveries(settings, monkeypatch, mailbox):
    from projects.backend.modules.communities import locations

    publish(settings, monkeypatch)
    with connect(settings.database) as database:
        database.execute("UPDATE jobs SET status = 'completed' WHERE kind = ?", (jobs.EMAIL_KIND,))
    counts = locations.remove(settings.database, settings.evidence_dir, LOCATION_ID)
    assert counts["email_deliveries"] == 2
