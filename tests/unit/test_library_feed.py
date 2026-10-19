import pytest

from projects.backend.modules.source_connectors.connectors.spl_rss import (
    FeedFormatError,
    parse_feed,
)
from projects.backend.modules.source_connectors.pipelines.events import load_source
from projects.backend.shared.configuration.settings import ROOT


@pytest.fixture
def feed():
    return (ROOT / "tests" / "fixtures" / "library_events.xml").read_bytes()


def test_extracts_only_approved_fields_and_verifies_venue(feed):
    events, skipped, closures = parse_feed(feed, load_source("spl-capitol-hill"))
    assert skipped == 1
    assert closures == 0
    assert len(events) == 1
    assert events[0].event_date == "2026-11-03"
    assert events[0].schedule_text == "Tuesday, November 3, 2026, 3 – 4pm"
    assert events[0].venue == "Capitol Hill Branch"
    assert events[0].room == "Meeting Room"
    assert "PRIVATE_DESCRIPTION" not in events[0].model_dump_json()
    assert "do-not-save" not in events[0].model_dump_json()


@pytest.mark.parametrize(
    "content",
    [
        b"<html>blocked</html>",
        b"<rss><channel>",
        b'<!DOCTYPE rss [<!ENTITY x "unsafe">]><rss><channel/></rss>',
        b"\x00<rss/>",
        b"x" * (2 * 1024 * 1024 + 1),
    ],
    ids=["html", "invalid-xml", "dtd", "nul", "oversized"],
)
def test_malformed_and_unsafe_responses_fail(content):
    with pytest.raises(FeedFormatError):
        parse_feed(content, load_source("spl-capitol-hill"))


def test_missing_dates_fail_instead_of_inventing_values(feed):
    with pytest.raises(FeedFormatError, match="calendar date"):
        parse_feed(feed.replace(b"2026/11/03", b"unknown"), load_source("spl-capitol-hill"))


def test_missing_venue_fails_instead_of_assuming_search_filter(feed):
    with pytest.raises(FeedFormatError, match="venue attribution"):
        parse_feed(
            feed.replace(b"Location Link", b"Unknown Field"), load_source("spl-capitol-hill")
        )


def test_unknown_source_is_not_fetchable():
    with pytest.raises(ValueError, match="not onboarded"):
        load_source("../../elsewhere")


def test_explicit_library_wide_closures_are_counted_and_not_retained(feed):
    closure = b"""<item><title>Library Closed in observance of Example Holiday</title>
    <description>Tuesday, November 3, 2026</description></item>"""
    content = feed.replace(b"</channel>", closure + b"</channel>")
    events, skipped, closures = parse_feed(content, load_source("spl-capitol-hill"))
    assert len(events) == 1
    assert skipped == 1
    assert closures == 1
