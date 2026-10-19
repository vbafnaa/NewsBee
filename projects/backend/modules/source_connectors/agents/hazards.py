"""Hazards agent: earthquakes the USGS recorded within NEARBY_KM of the town in 14 days.

Only quakes people may have noticed are kept (magnitude MIN_MAGNITUDE or more, or at least
MIN_FELT "Did You Feel It?" reports) within RADIUS_KM. Wording stays factual: no damage
claims or safety advice beyond what the USGS record says.

Quakes sharing a USGS reference place ("5 km SW of X" and "3 km N of X") become one story
listing each quake, ranked on the strongest magnitude, closest distance and total felt
reports, so a cluster never fills the edition with near-identical items.

Weather alerts are not included: api.weather.gov's robots.txt disallows all paths and the
alerts.weather.gov CAP feeds are retired, so no robots-permitted free source exists yet.
"""

import hashlib
import logging
import re
from datetime import date, timedelta

import httpx

from projects.backend.modules.source_connectors.agents.library_events import (
    DiscoveryBlockedError,
    Fetcher,
)
from projects.backend.modules.source_connectors.agents.regions import (
    LOCAL_KM,
    NEARBY_KM,
    USER_AGENT,
    region,
    result,
)
from projects.backend.modules.source_connectors.connectors import usgs
from projects.backend.modules.source_connectors.connectors.common import (
    MAX_FEED_BYTES,
    FeedFormatError,
)
from projects.backend.modules.source_connectors.connectors.news import NewsFacts, published_text

logger = logging.getLogger(__name__)
SOURCE_ID = "hazards:usgs"
PAST_DAYS = 14
RADIUS_KM = NEARBY_KM
QUERY_MAGNITUDE = 2.5
MIN_MAGNITUDE = 3.0
MIN_FELT = 10
MAX_ITEMS = 5
SECTION = "Earthquakes nearby"
OFFSET = re.compile(r"^\s*\d+(?:\.\d+)?\s*km\s+[NSEW]{1,3}\s+of\s+", re.IGNORECASE)


def noticeable(quake: dict) -> bool:
    return quake["magnitude"] >= MIN_MAGNITUDE or quake["felt"] >= MIN_FELT


def reference_place(place: str) -> str:
    """USGS place without its distance and bearing: "5 km SW of X" -> "X"."""
    return OFFSET.sub("", place).strip()


def group_by_place(quakes: list[dict]) -> list[list[dict]]:
    """Quakes sharing a reference place, each group strongest first, groups in input order."""
    groups: dict[str, list[dict]] = {}
    for quake in quakes:
        key = reference_place(quake["place"]).lower() or quake["id"]
        groups.setdefault(key, []).append(quake)
    return [
        sorted(group, key=lambda q: (-q["magnitude"], q["distance_km"], -q["felt"]))
        for group in groups.values()
    ]


def _tier(distance_km: float) -> str:
    return "local" if distance_km <= LOCAL_KM else "nearby"


def _review_note(quakes: list[dict]) -> str:
    if all(quake["reviewed"] for quake in quakes):
        return " A USGS seismologist has reviewed the reading" + ("s." if len(quakes) > 1 else ".")
    if len(quakes) == 1:
        return " The USGS reading is automatic and may be revised."
    return " Some USGS readings are automatic and may be revised."


def merged_facts(quakes: list[dict], town: str) -> NewsFacts:
    """One story for several quakes near the same reference place."""
    strongest = quakes[0]
    reference = reference_place(strongest["place"]) or "the same area"
    newest = max(quake["time"] for quake in quakes).date()
    closest = min(quake["distance_km"] for quake in quakes)
    felt = sum(quake["felt"] for quake in quakes)
    listed = "; ".join(
        f"magnitude {quake['magnitude']} on {published_text(quake['time'].date())}, "
        f"{quake['place']}, at a depth of {quake['depth_km']} km"
        + (f", felt by {quake['felt']} people" if quake["felt"] else "")
        for quake in sorted(quakes, key=lambda q: q["time"])
    )
    description = (
        f"The U.S. Geological Survey recorded {len(quakes)} earthquakes near {reference}, "
        f"about {closest} km from {town}: {listed}."
    )
    if felt:
        description += f" In total, {felt} people reported feeling them to the USGS."
    description += _review_note(quakes)
    return NewsFacts(
        source_event_id="+".join(sorted(quake["id"] for quake in quakes)),
        title=f"{len(quakes)} earthquakes up to magnitude {strongest['magnitude']} "
        f"near {reference}",
        event_date=newest.isoformat(),
        schedule_text=published_text(newest),
        venue=reference,
        source_url=strongest["url"] or "https://earthquake.usgs.gov/earthquakes/map/",
        description=description,
        kind="earthquake",
        tier=_tier(closest),
        section=SECTION,
        signals={
            "magnitude": strongest["magnitude"],
            "distance_km": closest,
            "felt": felt,
            "depth_km": strongest["depth_km"],
            "count": len(quakes),
        },
    )


def facts(quake: dict, town: str) -> NewsFacts:
    place = quake["place"] or "near the town"
    description = (
        f"The U.S. Geological Survey recorded a magnitude {quake['magnitude']} earthquake "
        f"{place}, at a depth of {quake['depth_km']} km, about {quake['distance_km']} km "
        f"from {town}."
    )
    if quake["felt"]:
        description += f" {quake['felt']} people reported feeling it to the USGS."
    description += _review_note([quake])
    day = quake["time"].date()
    return NewsFacts(
        source_event_id=quake["id"],
        title=f"Magnitude {quake['magnitude']} earthquake {place}".strip(),
        event_date=day.isoformat(),
        schedule_text=published_text(day),
        venue=place,
        source_url=quake["url"] or "https://earthquake.usgs.gov/earthquakes/map/",
        description=description,
        kind="earthquake",
        tier=_tier(quake["distance_km"]),
        section=SECTION,
        signals={
            "magnitude": quake["magnitude"],
            "distance_km": quake["distance_km"],
            "felt": quake["felt"],
            "depth_km": quake["depth_km"],
        },
    )


def collect(location: dict, client: httpx.Client, today: date, states=None):
    """Never raises for source problems: hazards are supplementary, so a failure is
    recorded on the result and the location's other sources still publish."""
    place = region(location, states)
    record = result(SOURCE_ID, "USGS earthquakes nearby", "ingested", "", feed_kind="usgs")
    if place.latitude is None or place.longitude is None:
        record.update(status="no_feed", detail="Location has no coordinates")
        return record, []
    url = usgs.query_url(
        place.latitude, place.longitude, today - timedelta(days=PAST_DAYS), RADIUS_KM,
        QUERY_MAGNITUDE,
    )
    record["feed_url"] = url
    try:
        _, content = Fetcher(client, USER_AGENT).get(url, MAX_FEED_BYTES, "application/json")
        quakes = usgs.parse(content, place.latitude, place.longitude)
    except DiscoveryBlockedError as error:
        record.update(status="blocked", detail=str(error))
        return record, []
    except (FeedFormatError, httpx.HTTPError) as error:
        record.update(status="failed", detail=f"{type(error).__name__}: {error}")
        return record, []
    near = [quake for quake in quakes if quake["distance_km"] <= RADIUS_KM]
    kept = [quake for quake in near if noticeable(quake)]
    skipped = {"too_far": len(quakes) - len(near), "below_threshold": len(near) - len(kept)}
    kept.sort(key=lambda quake: (-quake["magnitude"], quake["distance_km"]))
    groups = group_by_place(kept)
    made = [
        facts(group[0], place.town) if len(group) == 1 else merged_facts(group, place.town)
        for group in groups[:MAX_ITEMS]
    ]
    merged = len(kept) - len(groups)
    if merged:
        skipped["merged_same_place"] = merged
    record.update(
        detail=f"{len(quakes)} earthquakes of magnitude {QUERY_MAGNITUDE}+ within "
        f"{RADIUS_KM} km in {PAST_DAYS} days; {len(kept)} noticeable in {len(made)} stories",
        response_sha256=hashlib.sha256(content).hexdigest(),
        event_count=len(made),
        skipped_unusable={key: value for key, value in skipped.items() if value},
    )
    logger.info("Hazards result source_id=%s quakes=%s kept=%s", SOURCE_ID, len(quakes), len(made))
    return record, made
