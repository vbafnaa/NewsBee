"""Conservative private-POC eligibility, before spending tokens on a story.

These checks are not a factuality classifier. Unsupported/sensitive reporting stays
outside autonomous POC coverage even when the source is a public record.
"""

import re

from projects.backend.modules.source_connectors.connectors.common import https_link
from projects.backend.modules.source_connectors.connectors.meetings import PRIVATE

POLICY = "private_poc_v2"
SENSITIVE = re.compile(
    r"\b(alleg(?:ation|ations|ed|edly)|arrest(?:ed|s)?|charged with|suspect(?:s)?|"
    r"(?:sexual assault|domestic violence|eviction) (?:case|hearing|proceedings?)|"
    r"(?:suicide|homicide) investigation|disciplinary|medical records?)\b",
    re.I,
)
# Wider-area kinds come only from official newsrooms, USGS and public trend counts, and their
# connectors already drop deaths, crime, violence and politics before these checks run.
KINDS = {
    "event",
    "meeting_preview",
    "meeting_outcome",
    "state_news",
    "earthquake",
    "trending_topic",
    "social_trend",
}


def errors(story: dict) -> list[str]:
    result = []
    if story.get("kind", "event") not in KINDS:
        result.append("unsupported_story_kind")
    content = f"{story['title']} {story.get('description') or ''}"
    if SENSITIVE.search(content) or PRIVATE.search(content):
        result.append("sensitive_requires_editor")
    if not (story.get("description") or "").strip():
        result.append("insufficient_source_context")
    return result


def source_errors(urls: list[str]) -> list[str]:
    return [] if urls and all(https_link(url) for url in urls) else ["missing_source_link"]
