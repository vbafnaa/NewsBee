"""Where a location sits (town, county, nearby places) and the reviewed wider-area sources.

config/state-sources.json is keyed by USPS state code. Each state lists official newsroom
feeds, reviewed places with coordinates, Wikipedia articles worth watching (each tied to a
place), title aliases that tie a most-read article to the state, and each onboarded
location's county and centre point. Entries are reviewed by hand: only free, public,
robots-permitted sources belong there.

Wider-area stories stay community news: an item is kept only when it names the town
(``local``), its county (``region``) or a reviewed place within NEARBY_KM (``nearby``).
Statewide items that name none of these are dropped. Place names shared with well-known
places elsewhere (``ambiguous``) only count when the text also names the state or county,
unless the source itself is in-state.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from projects.backend.modules.source_connectors.connectors.common import https_link
from projects.backend.modules.source_connectors.connectors.news import mentions
from projects.backend.modules.source_connectors.connectors.usgs import distance_km
from projects.backend.shared.configuration.settings import ROOT

STATE_SOURCES = ROOT / "config" / "state-sources.json"
STATE_CODE = re.compile(r"^[A-Z]{2}$")
ARTICLE = re.compile(r"^[^\s#<>\[\]{}|]{1,200}$")
LOCAL_KM = 15
NEARBY_KM = 50
USER_AGENT = (
    "Newsbee-LocalPrototype/0.1 (community newsletter evaluation; "
    "https://github.com/Mitali-Shenoy/Newsbee)"
)


@dataclass(frozen=True)
class Region:
    location_id: str
    town: str
    state_code: str
    state_name: str | None = None
    county: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    aliases: tuple[str, ...] = ()
    place_suffix: str | None = None
    newsrooms: tuple[dict, ...] = ()
    watchlist: tuple[dict, ...] = field(default_factory=tuple)
    nearby: tuple[str, ...] = ()
    nearby_topics: tuple[dict, ...] = ()
    ambiguous: frozenset[str] = frozenset()

    @property
    def configured(self) -> bool:
        return self.state_name is not None

    def _named(self, texts: tuple[str | None, ...], name: str, qualified: bool) -> bool:
        if not any(mentions(text, name) for text in texts):
            return False
        if qualified or name not in self.ambiguous:
            return True
        anchors = (self.state_name, self.state_code, self.county)
        return any(mentions(text, anchor) for text in texts for anchor in anchors)

    def tier_for(self, *texts: str | None, qualified: bool = False) -> str | None:
        """local if the town is named, region if its county is, nearby if a reviewed place
        within NEARBY_KM is, otherwise None (too far away to be community news).
        ``qualified`` means the source is already in-state, so ambiguous names count."""
        if self._named(texts, self.town, qualified):
            return "local"
        if self.county and any(mentions(text, self.county) for text in texts):
            return "region"
        if any(self._named(texts, name, qualified) for name in self.nearby):
            return "nearby"
        return None

    def item_tier(self, title: str | None, body: str | None, qualified: bool = False):
        """The town or county may be named anywhere; a nearby place only counts in the
        title, since statewide items often mention a nearby venue in passing."""
        tier = self.tier_for(title, body, qualified=qualified)
        if tier == "nearby" and self.tier_for(title, qualified=qualified) != "nearby":
            return None
        return tier

    def section(self, tier: str) -> str:
        if tier == "local":
            return f"{self.town} in the news"
        if tier == "region" and self.county:
            return f"Around {self.county}"
        return f"Near {self.town}"


def result(source_id: str, name: str, status: str, detail: str, **values) -> dict:
    """The per-source ingestion record every collector returns (see SystemIngestion)."""
    return {
        "source_id": source_id,
        "name": name,
        "website": None,
        "status": status,
        "detail": detail,
        "feed_kind": None,
        "feed_url": None,
        "pages_checked": [],
        "response_sha256": None,
        "event_count": 0,
        "skipped_other_venues": 0,
        "skipped_outside_window": 0,
        "skipped_unusable": {},
        "unmatched_venues": {},
        **values,
    }


def load(path: Path = STATE_SOURCES) -> dict[str, dict]:
    if not path.exists():
        return {}
    states = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(states, dict):
        raise ValueError(f"{path.name} must map state codes to their sources")
    for code, state in states.items():
        where = f"{path.name} entry {code}"
        if not STATE_CODE.match(code) or not isinstance(state, dict) or not state.get("name"):
            raise ValueError(f"{where} needs an uppercase state code and a name")
        for newsroom in state.get("newsrooms", []):
            if not newsroom.get("name") or https_link(newsroom.get("feed")) is None:
                raise ValueError(f"{where}: every newsroom needs a name and an HTTPS feed")
        places = state.get("places", {})
        for name, point in places.items():
            if not _point(point):
                raise ValueError(f"{where}: place {name} needs [latitude, longitude]")
        for entry in state.get("watchlist", []):
            if not ARTICLE.match(str(entry.get("article", ""))) or not entry.get("about"):
                raise ValueError(f"{where}: every watchlist entry needs an article and about")
            if entry.get("place") not in places:
                raise ValueError(f"{where}: watchlist {entry['article']} needs a known place")
        for location_id, local in state.get("locations", {}).items():
            if "point" in local and not _point(local["point"]):
                raise ValueError(f"{where}: {location_id} point needs [latitude, longitude]")
    return states


def _point(value) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and all(isinstance(n, int | float) for n in value)
        and -90 <= value[0] <= 90
        and -180 <= value[1] <= 180
    )


def _within(places: dict, latitude: float | None, longitude: float | None) -> dict[str, float]:
    """Reviewed places within NEARBY_KM of the point, nearest first."""
    if latitude is None or longitude is None:
        return {}
    distances = {
        name: distance_km(latitude, longitude, point[0], point[1])
        for name, point in places.items()
    }
    return dict(sorted(
        ((name, km) for name, km in distances.items() if km <= NEARBY_KM),
        key=lambda pair: pair[1],
    ))


def region(location: dict, states: dict[str, dict] | None = None) -> Region:
    """A location profile -> its Region. The state comes from the location id suffix."""
    states = load() if states is None else states
    code = location["id"].rsplit("-", 1)[-1].upper()
    town = location["name"].split(",")[0].strip()
    point = next(
        (s for s in location.get("systems", []) if s.get("latitude") is not None), {}
    )
    state = states.get(code)
    if state is None:
        return Region(location["id"], town, code, None, None, point.get("latitude"),
                      point.get("longitude"))
    local = state.get("locations", {}).get(location["id"], {})
    latitude, longitude = local.get("point") or (point.get("latitude"), point.get("longitude"))
    near = _within(state.get("places", {}), latitude, longitude)
    return Region(
        location_id=location["id"],
        town=town,
        state_code=code,
        state_name=state["name"],
        county=local.get("county"),
        latitude=latitude,
        longitude=longitude,
        aliases=tuple(state.get("aliases", [])),
        place_suffix=state.get("place_suffix"),
        newsrooms=tuple(state.get("newsrooms", [])),
        watchlist=tuple(state.get("watchlist", [])),
        nearby=tuple(name for name in near if name != town),
        nearby_topics=tuple(e for e in state.get("watchlist", []) if e["place"] in near),
        ambiguous=frozenset(state.get("ambiguous_places", [])),
    )
