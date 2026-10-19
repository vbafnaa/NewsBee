"""Hazards agent: earthquakes the USGS recorded near the town in the past fortnight.

Only quakes people may have noticed are kept (magnitude MIN_MAGNITUDE or more, or at least
MIN_FELT "Did You Feel It?" reports) within RADIUS_KM. Wording stays factual: no damage
claims or safety advice beyond what the USGS record says.

Weather alerts are not included: api.weather.gov's robots.txt disallows all paths and the
alerts.weather.gov CAP feeds are retired, so no robots-permitted free source exists yet.
"""

import hashlib
import logging
from datetime import date, timedelta

import httpx

from projects.backend.modules.source_connectors.agents.library_events import (
    DiscoveryBlockedError,
    Fetcher,
)
from projects.backend.modules.source_connectors.agents.regions import USER_AGENT, region, result
from projects.backend.modules.source_connectors.connectors import usgs
from projects.backend.modules.source_connectors.connectors.common import (
    MAX_FEED_BYTES,
    FeedFormatError,
)
from projects.backend.modules.source_connectors.connectors.news import NewsFacts, published_text

logger = logging.getLogger(__name__)
SOURCE_ID = "hazards:usgs"
PAST_DAYS = 14
RADIUS_KM = 100
LOCAL_KM = 30
QUERY_MAGNITUDE = 2.5
MIN_MAGNITUDE = 3.0
MIN_FELT = 10
MAX_ITEMS = 5
SECTION = "Earthquakes nearby"


def noticeable(quake: dict) -> bool:
    return quake["magnitude"] >= MIN_MAGNITUDE or quake["felt"] >= MIN_FELT


def facts(quake: dict, town: str) -> NewsFacts:
    place = quake["place"] or "near the town"
    description = (
        f"The U.S. Geological Survey recorded a magnitude {quake['magnitude']} earthquake "
        f"{place}, at a depth of {quake['depth_km']} km, about {quake['distance_km']} km "
        f"from {town}."
    )
    if quake["felt"]:
        description += f" {quake['felt']} people reported feeling it to the USGS."
    description += (
        " A USGS seismologist has reviewed the reading."
        if quake["reviewed"]
        else " The USGS reading is automatic and may be revised."
    )
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
        tier="local" if quake["distance_km"] <= LOCAL_KM else "region",
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
    kept = [quake for quake in quakes if noticeable(quake) and quake["distance_km"] <= RADIUS_KM]
    kept.sort(key=lambda quake: (-quake["magnitude"], quake["distance_km"]))
    made = [facts(quake, place.town) for quake in kept[:MAX_ITEMS]]
    record.update(
        detail=f"{len(quakes)} earthquakes of magnitude {QUERY_MAGNITUDE}+ within "
        f"{RADIUS_KM} km in {PAST_DAYS} days; {len(made)} noticeable",
        response_sha256=hashlib.sha256(content).hexdigest(),
        event_count=len(made),
        skipped_unusable={"below_threshold": len(quakes) - len(kept)} if quakes != kept else {},
    )
    logger.info("Hazards result source_id=%s quakes=%s kept=%s", SOURCE_ID, len(quakes), len(made))
    return record, made
