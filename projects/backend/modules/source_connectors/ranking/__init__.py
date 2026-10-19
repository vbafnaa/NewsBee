"""Per-source story ranking: each source type supplies rules suited to its stories.

The editions module shortlists each source's best stories with these rules before the
model ranks the shortlist across sources. Rankers take story objects exposing ``title``,
``recurring``, ``first.event_date`` and ``facts`` (the first event's connector facts) and
return them best first. Add a source type by registering its ranker in ``RANKERS``.
"""

from collections.abc import Callable, Sequence

from projects.backend.modules.source_connectors.ranking import library, meetings, wider

Ranker = Callable[[Sequence], list]
RANKERS: dict[str, Ranker] = {
    "library": library.rank,
    "meetings": meetings.rank,
    "hazards": wider.hazards,
    "statenews": wider.state_news,
    "trending": wider.trending,
}


def source_type(source_id: str) -> str:
    """'library:WA0059' -> 'library'; 'meetings:civicclerk:auburnwa' -> 'meetings'."""
    return source_id.split(":", 1)[0]


def soonest(stories: Sequence) -> list:
    return sorted(stories, key=lambda story: (story.first.event_date, story.title))


def rank(kind: str, stories: Sequence) -> list:
    """Best first by the source type's rules; unknown types fall back to soonest first."""
    return RANKERS.get(kind, soonest)(stories)
