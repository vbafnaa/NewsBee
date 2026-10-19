"""Where a location sits (town, county, state) and the reviewed wider-area sources for it.

config/state-sources.json is keyed by USPS state code. Each state lists official newsroom
feeds, Wikipedia articles worth watching for statewide attention, title aliases that tie a
most-read article to the state, and each onboarded location's county. Entries are reviewed
by hand: only free, public, robots-permitted sources belong there.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from projects.backend.modules.source_connectors.connectors.common import https_link
from projects.backend.modules.source_connectors.connectors.news import mentions
from projects.backend.shared.configuration.settings import ROOT

STATE_SOURCES = ROOT / "config" / "state-sources.json"
STATE_CODE = re.compile(r"^[A-Z]{2}$")
ARTICLE = re.compile(r"^[^\s#<>\[\]{}|]{1,200}$")
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

    @property
    def configured(self) -> bool:
        return self.state_name is not None

    def tier_for(self, *texts: str | None) -> str:
        """local if the town is named, region if its county is, otherwise state."""
        if any(mentions(text, self.town) for text in texts):
            return "local"
        if self.county and any(mentions(text, self.county) for text in texts):
            return "region"
        return "state"

    def section(self, tier: str, statewide: str) -> str:
        if tier == "local":
            return f"{self.town} in the news"
        if tier == "region" and self.county:
            return f"Around {self.county}"
        return statewide


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
        for entry in state.get("watchlist", []):
            if not ARTICLE.match(str(entry.get("article", ""))) or not entry.get("about"):
                raise ValueError(f"{where}: every watchlist entry needs an article and about")
    return states


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
    return Region(
        location_id=location["id"],
        town=town,
        state_code=code,
        state_name=state["name"],
        county=local.get("county"),
        latitude=point.get("latitude"),
        longitude=point.get("longitude"),
        aliases=tuple(state.get("aliases", [])),
        place_suffix=state.get("place_suffix"),
        newsrooms=tuple(state.get("newsrooms", [])),
        watchlist=tuple(state.get("watchlist", [])),
    )
