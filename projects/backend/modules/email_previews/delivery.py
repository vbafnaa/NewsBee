"""Email previews of published editions, delivered only to the local Mailpit sink.

The email is a teaser: headline, intro, a persuasive blurb and one link to the full
edition on the website. Each subscriber has one delivery record per edition, so a
retry re-sends only to addresses that have not received it yet.
"""

import html
import json
import logging
import re
import smtplib
import time
from email.message import EmailMessage
from email.utils import make_msgid
from pathlib import Path
from urllib.parse import quote

from projects.backend.modules.editions import drafting
from projects.backend.modules.orchestration import jobs
from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.storage.database import connect
from shared.contracts.health import EmailDelivery

logger = logging.getLogger(__name__)
SENDER = "Newsbee preview <preview@newsbee.local>"
ADDRESS = re.compile(r"[^@\s<>,;]+@[^@\s<>,;]+")


class SendFailed(Exception):
    """At least one subscriber did not receive the preview; the job retries them later."""


def load_subscribers(settings: Settings) -> dict[str, list[str]]:
    """Local test subscribers per location id. A missing file means nobody is subscribed."""
    path = settings.subscribers_file
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    subscribers = data.get("locations") if isinstance(data, dict) else None
    if not isinstance(subscribers, dict):
        raise ValueError(f"{path} must contain a 'locations' object")
    for location_id, addresses in subscribers.items():
        if not isinstance(addresses, list) or not all(
            isinstance(address, str) and ADDRESS.fullmatch(address) for address in addresses
        ):
            raise ValueError(f"{path}: {location_id} must list plain email addresses")
    return {key: list(dict.fromkeys(value)) for key, value in subscribers.items()}


def queue(settings: Settings, location_id: str, edition_id: str) -> int:
    """Record one delivery per subscriber and queue the send job. Safe to repeat."""
    addresses = load_subscribers(settings).get(location_id, [])
    now = time.time()
    with connect(settings.database) as database:
        database.execute("BEGIN IMMEDIATE")
        superseded = database.execute(
            "UPDATE email_deliveries SET status = 'superseded', updated_at = ? "
            "WHERE status IN ('pending', 'failed') AND edition_id != ? AND edition_id IN "
            "(SELECT id FROM edition_drafts WHERE community_id = ?)",
            (now, edition_id, location_id),
        ).rowcount
        added = sum(
            database.execute(
                "INSERT OR IGNORE INTO email_deliveries "
                "(edition_id, address, status, updated_at) VALUES (?, ?, 'pending', ?)",
                (edition_id, address, now),
            ).rowcount
            for address in addresses
        )
        unsent = database.execute(
            "SELECT COUNT(*) FROM email_deliveries WHERE edition_id = ? "
            "AND status IN ('pending', 'failed')",
            (edition_id,),
        ).fetchone()[0]
        job_id = jobs.enqueue_within(database, location_id, jobs.EMAIL_KIND) if unsent else None
    logger.info(
        "Email previews queued edition_id=%s location_id=%s subscribers=%s added=%s "
        "unsent=%s superseded=%s job_id=%s",
        edition_id,
        location_id,
        len(addresses),
        added,
        unsent,
        superseded,
        job_id,
    )
    return added


def edition_url(settings: Settings, location_id: str) -> str:
    return f"{settings.website_url}/?location={quote(location_id)}"


def render(settings: Settings, edition_id: str, content: dict, address: str) -> EmailMessage:
    url = edition_url(settings, content["location_id"])
    headline = " ".join(content["headline"].split())
    message = EmailMessage()
    message["Subject"] = headline
    message["From"] = SENDER
    message["To"] = address
    message["Message-ID"] = make_msgid(domain="newsbee.local")
    message["X-Newsbee-Edition"] = edition_id
    message.set_content(
        f"{headline}\n\n{content['intro']}\n\n{content['blurb']}\n\n"
        f"Read the full {content['location_name']} edition: {url}\n"
    )
    escape = html.escape
    message.add_alternative(
        f"<h1>{escape(headline)}</h1>\n<p>{escape(content['intro'])}</p>\n"
        f"<p>{escape(content['blurb'])}</p>\n"
        f'<p><a href="{escape(url)}">Read the full {escape(content["location_name"])} '
        f"edition</a></p>\n",
        subtype="html",
    )
    return message


def _record(path: Path, edition_id: str, address: str, error: str | None) -> None:
    now = time.time()
    with connect(path) as database:
        database.execute(
            "UPDATE email_deliveries SET status = ?, attempts = attempts + 1, error = ?, "
            "updated_at = ?, sent_at = ? WHERE edition_id = ? AND address = ?",
            (
                "failed" if error else "sent",
                error,
                now,
                None if error else now,
                edition_id,
                address,
            ),
        )


def send(settings: Settings, location_id: str) -> dict:
    """Send every unsent preview for the location; raise SendFailed if any address failed."""
    with connect(settings.database) as database:
        rows = database.execute(
            "SELECT d.edition_id, d.address FROM email_deliveries d "
            "JOIN edition_drafts e ON e.id = d.edition_id "
            "WHERE e.community_id = ? AND d.status IN ('pending', 'failed') "
            "ORDER BY d.edition_id, d.address",
            (location_id,),
        ).fetchall()
    if not rows:
        return {"sent": 0, "failed": 0}
    contents = {
        edition_id: drafting.email_content(settings.database, edition_id)
        for edition_id in {row["edition_id"] for row in rows}
    }
    failures = []
    try:
        smtp = smtplib.SMTP(settings.mailpit_host, settings.mailpit_smtp_port, timeout=10)
    except (OSError, smtplib.SMTPException) as error:
        detail = f"{type(error).__name__}: {error}"
        for row in rows:
            _record(settings.database, row["edition_id"], row["address"], detail)
        logger.error("Email preview SMTP unavailable location_id=%s error=%s", location_id, detail)
        raise SendFailed(f"{len(rows)} of {len(rows)} previews not sent: {detail}") from error
    with smtp:
        for row in rows:
            edition_id, address = row["edition_id"], row["address"]
            try:
                smtp.send_message(render(settings, edition_id, contents[edition_id], address))
            except (OSError, smtplib.SMTPException) as error:
                detail = f"{type(error).__name__}: {error}"
                failures.append(detail)
                _record(settings.database, edition_id, address, detail)
                logger.error(
                    "Email preview failed edition_id=%s address=%s error=%s",
                    edition_id,
                    address,
                    detail,
                )
            else:
                _record(settings.database, edition_id, address, None)
                logger.info("Email preview sent edition_id=%s address=%s", edition_id, address)
    result = {"sent": len(rows) - len(failures), "failed": len(failures)}
    if failures:
        raise SendFailed(f"{len(failures)} of {len(rows)} previews not sent: {failures[0]}")
    return result


def statuses(path: Path) -> list[EmailDelivery]:
    """Delivery outcome of each location's most recently emailed edition."""
    latest: dict[str, EmailDelivery] = {}
    with connect(path) as database:
        rows = database.execute(
            "SELECT d.*, e.community_id FROM email_deliveries d "
            "JOIN edition_drafts e ON e.id = d.edition_id WHERE d.status != 'superseded' "
            "ORDER BY e.completed_at DESC, e.id DESC, d.address"
        ).fetchall()
    for row in rows:
        summary = latest.setdefault(
            row["community_id"],
            EmailDelivery(edition_id=row["edition_id"], location_id=row["community_id"]),
        )
        if summary.edition_id != row["edition_id"]:
            continue
        if row["status"] == "sent":
            summary.sent += 1
        elif row["status"] == "pending":
            summary.pending += 1
        else:
            summary.failed += 1
            summary.errors.append(f"{row['address']}: {row['error']}")
    return sorted(latest.values(), key=lambda item: item.location_id)
