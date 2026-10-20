import { beforeEach, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parsePhoton, boundary, withinArea, GEOGRAPHIC_PLACES, type GeographicPlace } from "../../../../../shared/geography";
import { searchGeography } from "../../communities/geocoder";
import { importLibraryDirectory, systemsInArea } from "../../communities/directory";
import { onboardLocation, getLocation } from "../../communities/locations";
import { discoverCommunityNews, feedLinks } from "../../communities/news-discovery";
import { communityEvidence } from "../../connectors/community";
import { parseNewsFeed } from "../../connectors/wider/adapters";
import { itemTier, resolveRegion } from "../../connectors/wider/regions";
import { stateNewsConnector } from "../../connectors/wider";
import { Fetcher } from "../../connectors/fetcher";
import { logger } from "../../core/log";
import { loadSettings } from "../../core/config";
import { searchTownDirectory, directoryTown } from "../../../../reader-site/src/lib/reader-data";
import { GET as searchRoute } from "@/app/api/admin/places/route";
import { POST as onboardRoute } from "@/app/api/admin/locations/route";
import { withMongo } from "../support/mongo";
import { ReplayTransport } from "../support/replay";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34" }]) }));
const state = vi.hoisted(() => ({ db: undefined as unknown, transport: undefined as unknown }));
vi.mock("@/lib/admin-api", () => ({ adminRoute: async (_request: Request, work: (context: unknown) => Promise<unknown>) =>
  Response.json(await work({ db: state.db, transport: state.transport, settings: loadSettings() })),
jsonBody: (request: Request) => request.json() }));
vi.mock("../../communities/bootstrap", () => ({ ensureDirectories: vi.fn() }));

const mongo = withMongo();
const feature = (extra: Record<string, unknown> = {}) => ({
  type: "Feature", properties: { osm_type: "N", osm_id: 150973716, osm_key: "place", osm_value: "suburb",
    type: "district", name: "Wallingford", city: "Seattle", county: "King", state: "Washington", countrycode: "US", ...extra },
  geometry: { type: "Point", coordinates: [-122.33434, 47.65946] },
});
const payload = (features = [feature()]) => ({ type: "FeatureCollection", features });
function resolved(): GeographicPlace { return parsePhoton(payload())[0]; }
const noNetwork = async () => { throw new Error("No external network access expected"); };
const noNews = async () => ({ newsrooms: [], gaps: ["No website published"] });
beforeEach(async () => {
  state.db = mongo.db;
  await mongo.db.collection<{ _id: string; data: object }>("source_configs").insertOne({ _id: "communities", data: {} });
});
async function store(place = resolved()) {
  await mongo.db.collection<GeographicPlace & { _id: string; name_lower: string }>(GEOGRAPHIC_PLACES).insertOne({ ...place, _id: place.id, name_lower: place.name.toLowerCase() });
  return place;
}

it("accepts arbitrary US communities with stable OSM IDs and rejects POIs, bad coordinates and non-US results", () => {
  const valid = resolved();
  expect(valid).toMatchObject({ id: "osm-n150973716-wa", label: "Wallingford, Seattle, WA", parent_kind: "city", area: { method: "approximate_radius", radius_km: 2 } });
  const value = payload([feature({ osm_key: "amenity", osm_value: "library" }), feature({ countrycode: "CA" }),
    feature({ state: "Unknown" }), feature({ osm_id: "bad" }), feature()]);
  expect(parsePhoton(value)).toHaveLength(1);
  expect(parsePhoton(payload([{ ...feature(), geometry: { type: "Point", coordinates: [999, 99] } }]))).toEqual([]);
  expect(() => parsePhoton({ message: "outage" })).toThrow("FeatureCollection");
  expect(parsePhoton(payload([feature({ osm_key: "boundary", osm_value: "administrative" })]))[0].kind).toBe("district");
  expect(parsePhoton(payload([feature({ city: undefined })]))[0]).toMatchObject({ parent_name: "King County", parent_kind: "county" });
  expect(parsePhoton(payload([feature({ city: undefined, county: undefined })]))[0].parent_kind).toBeNull();
});

it("uses provider extents only as approximate boxes and respects polygons, holes and multipolygons", () => {
  const place = parsePhoton(payload([feature({ extent: [-122.35, 47.67, -122.32, 47.65] })]))[0];
  expect(place.area.method).toBe("approximate_bbox");
  expect(withinArea(place.area, [place.longitude, place.latitude], [-122.33, 47.66])).toBe(true);
  expect(withinArea(place.area, [place.longitude, place.latitude], [-122.31, 47.66])).toBe(false);
  const polygon = boundary({ type: "Polygon", coordinates: [
    [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]],
    [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
  ] })!;
  expect(withinArea({ method: "boundary", boundary: polygon }, [0, 0], [3, 3])).toBe(true);
  expect(withinArea({ method: "boundary", boundary: polygon }, [0, 0], [1.5, 1.5])).toBe(false);
  const multi = boundary({ type: "MultiPolygon", coordinates: [polygon.coordinates] })!;
  expect(withinArea({ method: "boundary", boundary: multi }, [0, 0], [4, 4])).toBe(true);
  expect(boundary({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1]]] })).toBeNull();
  expect(parsePhoton(payload([{ ...feature(), geometry: polygon }]))[0].area.method).toBe("boundary");
});

it("caches explicit provider searches and persists results without trusting client-supplied metadata", async () => {
  const replay = new ReplayTransport().on(/photon/, { body: payload() });
  const first = await searchGeography(mongo.db, "Wallingford, Seattle, WA", replay.transport);
  const second = await searchGeography(mongo.db, "Wallingford, Seattle, WA", replay.transport);
  expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
  expect(replay.requests).toHaveLength(1);
  expect(new URL(replay.requests[0].url).searchParams.get("countrycode")).toBe("US");
  expect(await mongo.db.collection(GEOGRAPHIC_PLACES).countDocuments()).toBe(1);
  const profile = await onboardLocation(mongo.db, noNetwork, first[0].id, { overrides: {}, discoverNews: noNews });
  expect(profile).toMatchObject({ id: first[0].id, census_geoid: null, name: "Wallingford, Seattle, WA", systems: [],
    source_coverage: { status: "no_local_sources", area: "Approximate 2 km radius (not a boundary)" } });
  expect(profile.source_coverage?.gaps.join(" ")).toContain("No website published");
  await expect(onboardLocation(mongo.db, noNetwork, "osm-n999999-wa", { overrides: {} })).rejects.toThrow("not available");
  expect(await directoryTown(first[0].id, mongo.db)).toEqual({ id: first[0].id, name: first[0].label });
  expect(await searchTownDirectory("Wallingford, WA", mongo.db)).toEqual([{ id: first[0].id, name: first[0].label }]);
  expect(await searchTownDirectory("Wallingford, seattle, Washington", mongo.db)).toHaveLength(1);
  expect(await searchTownDirectory("Wallingford, Boston, Washington", mongo.db)).toEqual([]);
  const indexes = await mongo.db.collection("geographic_search_cache").indexes();
  expect(indexes.find((index) => index.name === "expires_at_1")?.expireAfterSeconds).toBe(0);
});

it("surfaces provider outages and malformed responses without caching a successful empty result", async () => {
  await expect(searchGeography(mongo.db, "Wallingford", new ReplayTransport().on(/photon/, { status: 503 }).transport)).rejects.toThrow("HTTP 503");
  expect(await mongo.db.collection("geographic_search_cache").countDocuments()).toBe(0);
  await mongo.db.collection("geographic_search_leases").deleteMany({});
  await expect(searchGeography(mongo.db, "Wallingford", new ReplayTransport().on(/photon/, { body: { error: "bad" } }).transport)).rejects.toThrow("FeatureCollection");
  expect(await mongo.db.collection(GEOGRAPHIC_PLACES).countDocuments()).toBe(0);
});

it("shares its provider lease across simultaneous identical searches", async () => {
  const replay = new ReplayTransport().on(/photon/, { body: payload() });
  const results = await Promise.all([
    searchGeography(mongo.db, "Wallingford", replay.transport),
    searchGeography(mongo.db, "Wallingford", replay.transport),
  ]);
  expect(results.map((places) => places[0].id)).toEqual(["osm-n150973716-wa", "osm-n150973716-wa"]);
  expect(replay.requests).toHaveLength(1);
});

it("keeps provider calls out of suggestion requests and requires an explicit geographic search", async () => {
  const { ensureDirectories } = await import("../../communities/bootstrap");
  const spy = vi.spyOn(await import("../../core/http"), "fetchTransport").mockImplementation(new ReplayTransport().on(/photon/, { body: payload() }).transport);
  try {
    await searchRoute(new Request("http://localhost/api/admin/places?q=Wallingford"));
    expect(spy).not.toHaveBeenCalled();
    expect(ensureDirectories).toHaveBeenCalled();
    const response = await searchRoute(new Request("http://localhost/api/admin/places?q=Wallingford&discover=1"));
    expect((await response.json()).results[0].id).toBe("osm-n150973716-wa");
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});

it("imports branch coordinates and scopes library systems without requiring a Census parent", async () => {
  const files = {
    "PLS_FY22_AE_test.csv": "STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,LATITUDE,LONGITUD\nWA,WA0001,SEATTLE PUBLIC LIBRARY,100 MAIN ST,SEATTLE,47.6,-122.3\n",
    "PLS_FY22_outlet_test.csv": "STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,C_OUT_TY,LATITUDE,LONGITUD\nWA,WA0001,WALLINGFORD BRANCH LIBRARY,1501 N 45TH ST,SEATTLE,BR,47.661,-122.337\nWA,WA0001,CENTRAL LIBRARY,100 MAIN ST,SEATTLE,CE,47.6,-122.3\nWA,WA0001,UNKNOWN BRANCH,1 MAIN ST,SEATTLE,BR,,\n",
  };
  await importLibraryDirectory(mongo.db, zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)]))));
  const place = await store();
  const { systems } = await systemsInArea(mongo.db, place);
  expect(systems.flatMap((system) => system.branches.map((branch) => branch.name))).toEqual(["Wallingford Branch Library"]);
  const profile = await onboardLocation(mongo.db, noNetwork, place.id, {
    overrides: { WA0001: { name: "Seattle Public Library", website: "https://library.example/" } }, discoverNews: noNews,
  });
  expect(profile.systems).toHaveLength(1);
  expect(communityEvidence(profile, ["Work at 1501 North 45th Street starts Monday"])).toMatchObject({ method: "selected_venue" });
  expect(communityEvidence(profile, ["Seattle budget review"])).toBeNull();
  expect(communityEvidence(profile, ["Bridge work in Wallingford"])).toMatchObject({ method: "community_mention" });
  expect(communityEvidence(profile, [""], [-122.335, 47.66])).toMatchObject({ method: "approximate_area" });
});

it("discovers and validates only actual RSS/Atom links from the community website", async () => {
  const place = await store({ ...resolved(), website: "https://community.example/" });
  const profile = await onboardLocation(mongo.db, noNetwork, place.id, { overrides: {}, discoverNews: noNews });
  const replay = new ReplayTransport()
    .on("https://community.example/", { body: '<link rel="alternate" type="application/rss+xml" href="/feed/"><a href="/invented">feed</a>' })
    .on("https://community.example/feed/", { body: "<rss><channel><title>Community</title></channel></rss>" });
  const found = await discoverCommunityNews(replay.transport, profile.community!);
  expect(found.newsrooms.map((room) => room.feed)).toEqual(["https://community.example/feed/"]);
  expect(found.gaps).toEqual([]);
  expect(feedLinks('<link rel="alternate" type="application/rss+xml" href="http://unsafe.example/feed">', place.website!)).toEqual([]);
  const unavailable = await discoverCommunityNews(new ReplayTransport().on("https://community.example/", { status: 503 }).transport, profile.community!);
  expect(unavailable.newsrooms).toEqual([]);
  expect(unavailable.gaps.join(" ")).toContain("unavailable");
});

it("reflects retained manual feeds in source readiness without changing the resolved community", async () => {
  const place = await store();
  await onboardLocation(mongo.db, noNetwork, place.id, { overrides: {}, discoverNews: noNews });
  await mongo.db.collection("location_source_links").insertOne({ location_id: place.id, connector: "statenews" });
  const profile = await getLocation(mongo.db, place.id);
  expect(profile.source_coverage?.status).toBe("partial");
  expect(profile.source_coverage?.gaps.join(" ")).not.toContain("No community RSS/Atom feed was found");
});

it("uses article GeoRSS coordinates as evidence without confusing the publisher or council meeting venue", async () => {
  const place = await store();
  const profile = await onboardLocation(mongo.db, noNetwork, place.id, { overrides: {}, discoverNews: noNews });
  const xml = `<rss xmlns:georss="http://www.georss.org/georss"><channel>${[
    ["in", "47.66 -122.335"], ["out", "47.60 -122.3"], ["invalid", "999 999"],
  ].map(([id, point]) => `<item><title>Bridge repairs ${id}</title><link>https://news.example/${id}</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><georss:point>${point}</georss:point></item>`).join("")}</channel></rss>`;
  const items = parseNewsFeed(new TextEncoder().encode(xml));
  const inside = items.find((item) => item.id.endsWith("/in"))!;
  expect(inside.coordinates).toEqual([-122.335, 47.66]);
  expect(items.find((item) => item.id.endsWith("/invalid"))?.coordinates).toBeUndefined();
  expect(itemTier(resolveRegion(profile, {}), inside.title, inside.summary, false, inside.coordinates)).toBe("local");
  await mongo.db.collection<{ _id: string; data: object }>("source_configs").insertOne({ _id: "state-sources", data: {} });
  const replay = new ReplayTransport().on("https://news.example/rss", { body: xml });
  const collected = await stateNewsConnector.collect({ type: "statenews", source_id: "statenews:manual", name: "Feed", params: { manual_feed: "https://news.example/rss" } }, {
    db: mongo.db, location: profile, settings: loadSettings(), transport: replay.transport, fetcher: new Fetcher(replay.transport),
    today: "2026-10-20", window: ["2026-10-21", "2026-10-27"], log: logger("test"),
    linkCache: { async get() { return null; }, async put() {}, async invalidate() {} },
  });
  expect(collected.events).toHaveLength(1);
  expect(collected.events[0].community_relevance).toMatchObject({ method: "approximate_area" });
});

it("requires a jurisdiction anchor for generic community names and records government discovery failures as gaps", async () => {
  const place = await store({ ...resolved(), name: "Downtown", label: "Downtown, Seattle, WA" });
  const profile = await onboardLocation(mongo.db, noNetwork, place.id, {
    overrides: {}, discoverNews: noNews, discoverGovernment: async () => { throw new Error("Jurisdiction lookup unavailable"); },
  });
  expect(profile.source_coverage?.gaps.join(" ")).toContain("Government discovery unavailable");
  expect(communityEvidence(profile, ["Downtown Los Angeles improvements"])).toBeNull();
  expect(communityEvidence(profile, ["Downtown Seattle improvements"])).toMatchObject({ method: "community_mention" });
  expect(communityEvidence(profile, ["Downtown improvements"], [-122.335, 47.66])).toMatchObject({ method: "approximate_area" });
});

it("does not let unavailable reference directories block onboarding a resolved provider place", async () => {
  const place = await store();
  await mongo.db.collection<{ _id: string; data: object }>("source_configs").insertOne({ _id: "government-sources", data: {} });
  const { ensureDirectories } = await import("../../communities/bootstrap");
  vi.mocked(ensureDirectories).mockRejectedValueOnce(new Error("IMLS download unavailable"));
  const spy = vi.spyOn(await import("../../core/http"), "fetchTransport").mockImplementation(noNetwork);
  try {
    const response = await onboardRoute(new Request("http://localhost/api/admin/locations", { method: "POST", body: JSON.stringify({ place_id: place.id }) }));
    expect((await response.json()).location.source_coverage.gaps.join(" ")).toContain("Reference library directory unavailable");
    expect(ensureDirectories).toHaveBeenLastCalledWith(mongo.db, expect.any(Function), { libraryCoordinates: true, skipCensus: true });
  } finally { spy.mockRestore(); }
});
