"""USGS earthquake catalog (FDSN event web service, GeoJSON). Public domain, no key.

https://earthquake.usgs.gov/fdsnws/event/1/ - queried by point and radius, so one call per
location covers the past fortnight.
"""

import json
import math
from datetime import UTC, date, datetime
from urllib.parse import urlencode

from projects.backend.modules.source_connectors.connectors.common import (
    FeedFormatError,
    check_count,
    check_size,
    https_link,
)

ENDPOINT = "https://earthquake.usgs.gov/fdsnws/event/1/query"


def query_url(latitude: float, longitude: float, start: date, radius_km: int, minimum: float):
    params = {
        "format": "geojson",
        "latitude": f"{latitude:.4f}",
        "longitude": f"{longitude:.4f}",
        "maxradiuskm": radius_km,
        "starttime": start.isoformat(),
        "minmagnitude": minimum,
        "eventtype": "earthquake",
        "orderby": "time",
        "limit": 100,
    }
    return f"{ENDPOINT}?{urlencode(params)}"


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi, dlambda = phi2 - phi1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def parse(content: bytes, latitude: float, longitude: float) -> list[dict]:
    """GeoJSON -> earthquakes with magnitude, place, time, felt reports and distance."""
    check_size(content)
    try:
        features = json.loads(content)["features"]
    except (ValueError, KeyError, TypeError) as error:
        raise FeedFormatError(f"USGS response is not GeoJSON: {error}") from error
    check_count(len(features))
    quakes = []
    for feature in features:
        try:
            properties = feature["properties"]
            lon, lat, depth = feature["geometry"]["coordinates"][:3]
            magnitude = float(properties["mag"])
            moment = datetime.fromtimestamp(properties["time"] / 1000, UTC)
        except (KeyError, TypeError, ValueError):
            continue
        if properties.get("type", "earthquake") != "earthquake":
            continue
        quakes.append(
            {
                "id": str(feature.get("id") or properties.get("code")),
                "magnitude": round(magnitude, 1),
                "place": str(properties.get("place") or "").strip(),
                "time": moment,
                "depth_km": round(float(depth or 0), 1),
                "felt": int(properties.get("felt") or 0),
                "alert": properties.get("alert"),
                "tsunami": bool(properties.get("tsunami")),
                "reviewed": properties.get("status") == "reviewed",
                "url": https_link(properties.get("url")),
                "distance_km": round(distance_km(latitude, longitude, lat, lon)),
            }
        )
    return quakes
