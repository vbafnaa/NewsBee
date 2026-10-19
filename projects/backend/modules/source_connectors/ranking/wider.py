"""Ranking rules for wider-area stories (hazards, state newsrooms, statewide trends).

Every wider ranker puts stories that name the town first, then the county, then the state
(``TIER_ORDER``); within a tier each source type has its own rules below.
"""

import re
from collections import Counter
from collections.abc import Sequence
from datetime import date

TIER_ORDER = {"local": 0, "region": 1, "state": 2}

PRACTICAL = re.compile(
    r"\b(closures?|closed|closing|detours?|lanes?|ferr(?:y|ies)|roads?|highways?|bridges?|"
    r"I-\d+|SR \d+|traffic|construction|recalls?|outbreaks?|vaccin\w*|flu|advisor(?:y|ies)|"
    r"warnings?|scams?|fraud|grants?|funding|deadlines?|apply|applications?|benefits?|"
    r"wildfires?|burn bans?|floods?|flooding|storms?|snow|power|water|schools?|consumers?|"
    r"refunds?|settlements?|prices?|rent|housing|jobs?|wages?|fees?|tolls?)\b",
    re.IGNORECASE,
)
CEREMONIAL = re.compile(
    r"\b(appoint\w*|reappoint\w*|proclam\w*|honou?rs?|commemorat\w*|condolences?|"
    r"half-staff|trade mission|travels?|statement|nominat\w*|welcomes?|congratulat\w*)\b",
    re.IGNORECASE,
)


def tier(story) -> int:
    return TIER_ORDER.get(story.facts.get("tier"), len(TIER_ORDER))


def signal(story, name: str, default=0):
    return (story.facts.get("signals") or {}).get(name, default)


def _date_desc(story) -> int:
    """Newest first when used inside an ascending sort key."""
    return -date.fromisoformat(story.first.event_date).toordinal()


def spread(stories: list, group) -> list:
    """Keep the given order but interleave groups, so one publisher or source cannot
    take the whole shortlist: each group's nth story follows every group's (n-1)th."""
    seen: Counter = Counter()
    indexed = []
    for position, story in enumerate(stories):
        key = (tier(story), group(story))
        indexed.append(((tier(story), seen[key], position), story))
        seen[key] += 1
    return [story for _, story in sorted(indexed, key=lambda pair: pair[0])]


def hazards(stories: Sequence) -> list:
    """Nearest tier, then strongest, then closest, then most felt, then newest."""
    return sorted(
        stories,
        key=lambda s: (
            tier(s),
            -signal(s, "magnitude"),
            signal(s, "distance_km"),
            -signal(s, "felt"),
            _date_desc(s),
        ),
    )


def state_news_score(story) -> int:
    title, description = story.title, story.facts.get("description") or ""
    score = 0
    score += 20 if PRACTICAL.search(title) else 10 if PRACTICAL.search(description) else 0
    score -= 30 if CEREMONIAL.search(title) else 0
    return score


def state_news(stories: Sequence) -> list:
    """Town, then county, then statewide; practical public-service news (roads, ferries,
    health, scams, deadlines) over ceremonial items (appointments, proclamations); newest
    first; publishers interleaved so no one agency fills the shortlist."""
    ordered = sorted(stories, key=lambda s: (tier(s), -state_news_score(s), _date_desc(s)))
    return spread(ordered, lambda s: s.facts.get("venue"))


def trend_strength(story) -> float:
    if story.facts.get("kind") == "social_trend":
        return float(signal(story, "post_count"))
    return float(signal(story, "ratio")) * 1000 + float(signal(story, "recent_daily_views")) / 1e6


def trending(stories: Sequence) -> list:
    """Town, then county, then state; within a source, the biggest jump over usual
    attention (Wikipedia) or the most posts (Bluesky), with social mentions breaking ties;
    the two sources interleaved."""
    ordered = sorted(
        stories,
        key=lambda s: (tier(s), -trend_strength(s), -(s.facts.get("social_mentions") or 0)),
    )
    return spread(ordered, lambda s: s.facts.get("kind"))
