"""Resolve an official website (library system or town) from Wikidata (property P856).

A Wikidata item counts only if its English label equals the system name, it lists a
website, and its coordinates are within MAX_DISTANCE_KM of the directory's address.
Anything else leaves the website unresolved rather than guessing.
"""

import math
from urllib.parse import urlsplit, urlunsplit

import httpx

API = "https://www.wikidata.org/w/api.php"
HEADERS = {"User-Agent": "Newsbee-LocalPrototype/0.1 (local library onboarding)"}
MAX_DISTANCE_KM = 50
UNITED_STATES = "Q30"


def _values(claims: dict, prop: str) -> list:
    return [
        claim["mainsnak"]["datavalue"]["value"]
        for claim in claims.get(prop, [])
        if claim.get("mainsnak", {}).get("datavalue")
    ]


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((phi2 - phi1) / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 6371 * 2 * math.asin(math.sqrt(a))


def https_origin(url: str) -> str | None:
    """Wikidata sometimes records http://; discovery only fetches over HTTPS."""
    parts = urlsplit(url.strip())
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username:
        return None
    return urlunsplit(("https", parts.hostname, parts.path or "/", "", ""))


def lookup_website(client: httpx.Client, system: dict) -> dict:
    """Return {'status': 'resolved'|'unresolved', 'website', 'wikidata_id', 'detail'}."""
    return lookup(client, system["name"], system.get("latitude"), system.get("longitude"))


def lookup(
    client: httpx.Client, name: str, latitude: float | None, longitude: float | None
) -> dict:
    """Official website of the item labelled exactly `name` near the given coordinates."""
    found = client.get(
        API,
        params={
            "action": "wbsearchentities",
            "search": name,
            "language": "en",
            "type": "item",
            "limit": 10,
            "format": "json",
        },
        headers=HEADERS,
    )
    found.raise_for_status()
    ids = [
        item["id"]
        for item in found.json().get("search", [])
        if item.get("label", "").casefold() == name.casefold()
    ]
    if not ids:
        return _unresolved(f"No Wikidata item labelled exactly {name!r}")
    response = client.get(
        API,
        params={
            "action": "wbgetentities",
            "ids": "|".join(ids),
            "props": "claims",
            "format": "json",
        },
        headers=HEADERS,
    )
    response.raise_for_status()
    if latitude is None or longitude is None:
        return _unresolved("Directory has no coordinates to confirm the Wikidata match")
    candidates: dict[str, str] = {}
    for identity, entity in response.json().get("entities", {}).items():
        claims = entity.get("claims", {})
        countries = {value.get("id") for value in _values(claims, "P17")}
        coordinates = _values(claims, "P625")
        websites = [https_origin(value) for value in _values(claims, "P856")]
        nearby = any(
            distance_km(latitude, longitude, point["latitude"], point["longitude"])
            <= MAX_DISTANCE_KM
            for point in coordinates
        )
        if UNITED_STATES in countries and nearby:
            for website in filter(None, websites):
                candidates[website] = identity
    if len(candidates) == 1:
        website, identity = next(iter(candidates.items()))
        return {
            "status": "resolved",
            "website": website,
            "wikidata_id": identity,
            "detail": f"Official website from Wikidata {identity}",
        }
    if not candidates:
        return _unresolved(
            f"No Wikidata match for {name!r} with a website and coordinates within "
            f"{MAX_DISTANCE_KM} km"
        )
    return _unresolved(f"Ambiguous Wikidata websites for {name!r}: {sorted(candidates)}")


def _unresolved(detail: str) -> dict:
    return {"status": "unresolved", "website": None, "wikidata_id": None, "detail": detail}
