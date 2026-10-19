import csv
import io
import zipfile

import httpx
import pytest

from projects.backend.modules.communities import directory, locations, wikidata
from projects.backend.modules.communities.venues import match_branch
from projects.backend.modules.source_connectors.agents import government_meetings
from projects.backend.shared.storage.database import initialize

SYSTEMS = [
    {
        "STABR": "WA",
        "FSCSKEY": "WA0001",
        "LIBNAME": "SEATTLE PUBLIC LIBRARY",
        "ADDRESS": "1000 4TH AVE",
        "CITY": "SEATTLE",
        "LATITUDE": "47.6",
        "LONGITUD": "-122.3",
    },
    {
        "STABR": "WA",
        "FSCSKEY": "WA0002",
        "LIBNAME": "KING COUNTY LIBRARY SYSTEM",
        "ADDRESS": "960 NEWPORT WAY NW",
        "CITY": "ISSAQUAH",
        "LATITUDE": "47.5",
        "LONGITUD": "-122.0",
    },
    {
        "STABR": "OR",
        "FSCSKEY": "OR0001",
        "LIBNAME": "SEASIDE PUBLIC LIBRARY",
        "ADDRESS": "1131 BROADWAY",
        "CITY": "SEASIDE",
        "LATITUDE": "46.0",
        "LONGITUD": "-123.9",
    },
]
OUTLETS = [
    {
        "STABR": "WA",
        "FSCSKEY": "WA0001",
        "LIBNAME": "CAPITOL HILL BRANCH",
        "ADDRESS": "425 HARVARD AVE E",
        "CITY": "SEATTLE",
        "C_OUT_TY": "BR",
    },
    {
        "STABR": "WA",
        "FSCSKEY": "WA0001",
        "LIBNAME": "CENTRAL LIBRARY",
        "ADDRESS": "1000 4TH AVE",
        "CITY": "SEATTLE",
        "C_OUT_TY": "CE",
    },
    {
        "STABR": "WA",
        "FSCSKEY": "WA0001",
        "LIBNAME": "MOBILE SERVICES",
        "ADDRESS": "1 VAN WAY",
        "CITY": "SEATTLE",
        "C_OUT_TY": "BM",
    },
    {
        "STABR": "WA",
        "FSCSKEY": "WA0002",
        "LIBNAME": "BOULEVARD PARK LIBRARY",
        "ADDRESS": "12015 ROSEBERG AVE S",
        "CITY": "SEATTLE",
        "C_OUT_TY": "BR",
    },
    {
        "STABR": "OR",
        "FSCSKEY": "OR0001",
        "LIBNAME": "SEASIDE PUBLIC LIBRARY",
        "ADDRESS": "1131 BROADWAY",
        "CITY": "SEASIDE",
        "C_OUT_TY": "CE",
    },
]


def table(rows: list[dict]) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def archive() -> bytes:
    content = io.BytesIO()
    with zipfile.ZipFile(content, "w") as file:
        file.writestr("PLS_FY22_AE_pud22i.csv", table(SYSTEMS))
        file.writestr("pls_fy22_outlet_pud22i.csv", table(OUTLETS))
    return content.getvalue()


@pytest.fixture
def index(tmp_path):
    path = directory.directory_path(tmp_path)
    assert directory.build(archive(), path) == {"systems": 3, "outlets": 4, "places": 2}
    return path


def test_search_ranks_exact_town_and_narrows_by_state(index):
    assert [result["id"] for result in directory.search(index, "Sea")] == [
        "seattle-wa",
        "seaside-or",
    ]
    [seattle] = directory.search(index, "seattle")
    assert seattle == {
        "id": "seattle-wa",
        "name": "Seattle, WA",
        "branch_count": 3,
        "system_count": 2,
    }
    assert directory.search(index, "Sea, OR")[0]["id"] == "seaside-or"
    assert directory.search(index, "S") == []
    assert directory.search(index, "%") == []


def test_place_lists_every_system_and_only_in_town_branches(index):
    place = directory.place(index, "seattle-wa")
    assert place["name"] == "Seattle, WA" and place["directory_edition"] == "IMLS PLS FY2022"
    spl, kcls = place["systems"]
    assert spl["name"] == "Seattle Public Library"
    assert [branch["name"] for branch in spl["branches"]] == [
        "Capitol Hill Branch",
        "Central Library",
    ]
    assert spl["branches"][1]["address"] == "1000 4th Ave"
    assert [branch["address"] for branch in kcls["branches"]] == ["12015 Roseberg Ave S"]
    with pytest.raises(LookupError):
        directory.place(index, "nowhere-xx")


def test_missing_or_invalid_directory_is_explained(tmp_path):
    with pytest.raises(directory.DirectoryUnavailableError, match="setup-directory"):
        directory.search(tmp_path / "missing.sqlite3", "Seattle")
    with pytest.raises(directory.DirectoryUnavailableError, match="not a ZIP"):
        directory.build(b"<html>", tmp_path / "index.sqlite3")


def test_search_api_returns_candidates(client, settings):
    directory.build(archive(), directory.directory_path(settings.data_dir))
    response = client.get("/api/locations/search", params={"q": "seattle, wa"})
    assert response.status_code == 200
    assert [result["id"] for result in response.json()["results"]] == ["seattle-wa"]


def wikidata_transport(entities: dict, search_ids: list[str]) -> httpx.MockTransport:
    def respond(request):
        if request.url.host != "www.wikidata.org":
            return httpx.Response(404)
        if request.url.params["action"] == "wbsearchentities":
            hits = [{"id": key, "label": "Seattle Public Library"} for key in search_ids]
            return httpx.Response(200, json={"search": hits})
        return httpx.Response(200, json={"entities": entities})

    return httpx.MockTransport(respond)


def entity(latitude: float, website: str | None = "http://www.spl.org/", country="Q30") -> dict:
    claims = {
        "P17": [{"mainsnak": {"datavalue": {"value": {"id": country}}}}],
        "P625": [
            {"mainsnak": {"datavalue": {"value": {"latitude": latitude, "longitude": -122.3}}}}
        ],
    }
    if website:
        claims["P856"] = [{"mainsnak": {"datavalue": {"value": website}}}]
    return {"claims": claims}


SYSTEM = {"name": "Seattle Public Library", "latitude": 47.6, "longitude": -122.3}


@pytest.mark.parametrize(
    ("entities", "status", "website"),
    [
        ({"Q1": entity(47.61)}, "resolved", "https://www.spl.org/"),
        ({"Q1": entity(10.0)}, "unresolved", None),
        ({"Q1": entity(47.61, country="Q16")}, "unresolved", None),
        ({"Q1": entity(47.61, website=None)}, "unresolved", None),
        (
            {"Q1": entity(47.61), "Q2": entity(47.62, "https://other.example")},
            "unresolved",
            None,
        ),
    ],
    ids=["resolved", "too-far", "not-us", "no-website", "ambiguous"],
)
def test_wikidata_website_needs_one_nearby_us_match(entities, status, website):
    with httpx.Client(transport=wikidata_transport(entities, list(entities))) as client:
        result = wikidata.lookup_website(client, SYSTEM)
    assert (result["status"], result["website"]) == (status, website)


def test_wikidata_needs_system_coordinates():
    with httpx.Client(transport=wikidata_transport({}, [])) as client:
        result = wikidata.lookup_website(client, {**SYSTEM, "latitude": None})
    assert result["status"] == "unresolved"


def test_onboarding_saves_profile_with_lookup_results(tmp_path, index):
    database = tmp_path / "newsbee.sqlite3"
    initialize(database)
    with httpx.Client(transport=wikidata_transport({"Q1": entity(47.61)}, ["Q1"])) as client:
        profile = locations.onboard(tmp_path, database, "seattle-wa", client)
    assert locations.get(database, "seattle-wa") == profile
    assert [system["website"] for system in profile["systems"]] == ["https://www.spl.org/", None]
    with pytest.raises(LookupError, match="not onboarded"):
        locations.get(database, "elsewhere")


def test_onboarding_prefers_a_reviewed_website_override(tmp_path, index):
    database = tmp_path / "newsbee.sqlite3"
    initialize(database)
    override = {"WA0002": {"name": "King County Library System", "website": "https://kcls.org/"}}
    with httpx.Client(transport=wikidata_transport({}, [])) as client:
        profile = locations.onboard(tmp_path, database, "seattle-wa", client, override)
        kcls = profile["systems"][1]
        assert (kcls["website"], kcls["website_lookup"]["status"]) == (
            "https://kcls.org/",
            "override",
        )
        assert profile["systems"][0]["website_lookup"]["status"] == "unresolved"
        wrong = {"WA0002": {"name": "Elsewhere Library", "website": "https://kcls.org/"}}
        with pytest.raises(ValueError, match="directory lists"):
            locations.onboard(tmp_path, database, "seattle-wa", client, wrong)


@pytest.mark.parametrize(
    ("content", "error"),
    [
        ("[]", "must map"),
        ('{"WA1": {"name": "X", "website": "http://x.example"}}', "https://"),
        ('{"WA1": {"website": "https://x.example"}}', "needs a name"),
    ],
)
def test_website_override_file_is_validated(tmp_path, content, error):
    path = tmp_path / "library-websites.json"
    assert locations.website_overrides(path) == {}
    path.write_text(content, encoding="utf-8")
    with pytest.raises(ValueError, match=error):
        locations.website_overrides(path)


def test_committed_website_overrides_are_valid():
    overrides = locations.website_overrides()
    assert overrides["WA0060"] == {
        "name": "Kitsap Regional Library",
        "website": "https://www.krl.org/",
    }


def test_onboarding_records_the_government_meeting_source(tmp_path, index):
    database = tmp_path / "newsbee.sqlite3"
    initialize(database)
    with httpx.Client(transport=wikidata_transport({}, [])) as client:
        found = locations.onboard(tmp_path, database, "seattle-wa", client, {}, {})
        assert found["government"]["status"] == "unresolved_website"
        reviewed = {"seattle-wa": {"platform": "legistar", "tenant": "seattle"}}
        profile = locations.onboard(tmp_path, database, "seattle-wa", client, {}, reviewed)
    assert (profile["government"]["status"], profile["government"]["tenant"]) == (
        "override",
        "seattle",
    )
    assert locations.get(database, "seattle-wa")["government"] == profile["government"]


@pytest.mark.parametrize(
    "content",
    [
        "[]",
        '{"x": {"platform": "primegov", "tenant": "x"}}',
        '{"x": {"platform": "legistar", "tenant": "Bad Name"}}',
    ],
)
def test_government_override_file_is_validated(tmp_path, content):
    path = tmp_path / "government-sources.json"
    assert government_meetings.overrides(path) == {}
    path.write_text(content, encoding="utf-8")
    with pytest.raises(ValueError, match="government-sources.json"):
        government_meetings.overrides(path)


def test_committed_government_overrides_are_valid():
    assert isinstance(government_meetings.overrides(), dict)


BRANCHES = [
    {"name": "Capitol Hill Branch", "address": "425 Harvard Ave E"},
    {"name": "Central Library", "address": "1000 4th Ave"},
    {"name": "Madrona-Sally Goldmark Branch", "address": "1134 33rd Ave"},
]


@pytest.mark.parametrize(
    ("venue", "branch"),
    [
        ("Capitol Hill Branch", "Capitol Hill Branch"),
        ("The Capitol Hill Library", "Capitol Hill Branch"),
        ("Central Library", "Central Library"),
        ("Madrona-Sally Goldmark Branch", "Madrona-Sally Goldmark Branch"),
        ("Community room, 425 Harvard Avenue East, Seattle", "Capitol Hill Branch"),
        ("Online", None),
        ("non-library location", None),
        ("Capitol Hill Park", None),
    ],
)
def test_venue_matching_is_exact_after_normalising(venue, branch):
    assert match_branch(venue, BRANCHES) == branch
