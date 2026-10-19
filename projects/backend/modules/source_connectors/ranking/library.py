"""Library events: one-off events first, then civic and practical help, then soonest."""

import re
from collections.abc import Sequence

PRACTICAL = re.compile(
    r"\b(services?|help|resources?|assistance|support|tax(es)?|legal|health|housing|jobs?|"
    r"careers?|employment|citizenship|benefits?|vot(e|er|ers|ing)|clinic|insurance|"
    r"medicare|financ\w*)\b",
    re.IGNORECASE,
)


def rank(stories: Sequence) -> list:
    """Practical keywords are matched on the title only; descriptions use them too loosely."""
    return sorted(
        stories,
        key=lambda story: (
            story.recurring,
            not PRACTICAL.search(story.title),
            story.first.event_date,
            story.title,
        ),
    )
