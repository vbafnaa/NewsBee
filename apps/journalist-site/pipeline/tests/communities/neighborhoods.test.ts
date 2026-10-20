import { beforeEach, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { COMMUNITY_SEED, communityDirectory, matchingCommunities } from "../../../../../shared/community-directory";
import { importCensusPlaces } from "../../communities/census";
import { importLibraryDirectory, searchPlaces } from "../../communities/directory";
import { onboardLocation, updateSources } from "../../communities/locations";
import { libraryConnector } from "../../connectors/library";
import { discoverGovernment, meetingsConnector } from "../../connectors/meetings";
import { scopeMeeting } from "../../connectors/meetings";
import { preview, type Meeting } from "../../connectors/meetings/meetings";
import { itemTier, resolveRegion, trendTier } from "../../connectors/wider/regions";
import { stateNewsConnector } from "../../connectors/wider";
import { Fetcher } from "../../connectors/fetcher";
import { MongoLinkCache } from "../../storage/link-cache";
import { loadSettings } from "../../core/config";
import { logger } from "../../core/log";
import type { ConnectorContext, LocationProfile } from "../../connectors/types";
import { withMongo } from "../support/mongo";
import { ReplayTransport } from "../support/replay";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34" }]) }));

const mongo = withMongo();
const communities = communityDirectory(COMMUNITY_SEED);
const ballard = communities["ballard-seattle-wa"];
const settings = loadSettings({ ...process.env, NEWSBEE_ROOT: process.cwd(), NEWSBEE_WIDER_SOURCES: "1" });
const noNetwork = async () => { throw new Error("Unexpected network access"); };
const zip = (name: string, data: string) => zipSync({ [name]: strToU8(data) });
const census = () => zip("2023_Gaz_place_national.txt",
  "GEOID\tUSPS\tNAME\tFUNCSTAT\tINTPTLAT\tINTPTLONG\n5363000\tWA\tSeattle city\tA\t47.6038\t-122.3301\n");
const overrides = { WA0001: { name: "Seattle Public Library", website: "https://library.example/" } };
const onboard = (id: string) => onboardLocation(mongo.db, noNetwork, id, { overrides });
function profile(community = ballard): LocationProfile {
  return { id: `${community.name.toLowerCase().replaceAll(" ", "-")}-seattle-wa`, name: `${community.name}, Seattle, WA`,
    state: "WA", community, latitude: community.latitude, longitude: community.longitude, systems: [] };
}
function context(replay: ReplayTransport, location = profile()): ConnectorContext {
  return { location, transport: replay.transport, fetcher: new Fetcher(replay.transport), settings,
    db: mongo.db, linkCache: new MongoLinkCache(mongo.db), today: "2026-10-19", window: ["2026-10-20", "2026-10-26"], log: logger("community-test") };
}
beforeEach(async () => {
  await importCensusPlaces(mongo.db, census());
  const branches = [...new Set(Object.values(communities).flatMap((community) => community.library_branches)), "Central Library"];
  await importLibraryDirectory(mongo.db, zipSync({
    "PLS_FY22_AE_test.csv": strToU8("STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,LATITUDE,LONGITUD\nWA,WA0001,SEATTLE PUBLIC LIBRARY,100 MAIN ST,SEATTLE,47.6,-122.3\n"),
    "PLS_FY22_outlet_test.csv": strToU8(`STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,C_OUT_TY\n${branches.map((branch, index) => `WA,WA0001,${branch.toUpperCase()}${branch.endsWith("Branch") ? " LIBRARY" : ""},${index + 1} MAIN ST,SEATTLE,BR`).join("\n")}`),
  }));
});

it("searches distinct neighborhoods, aliases, parent city and full state names without confusing Fremont CA", async () => {
  for (const query of ["Fremont", "Freemont", "Fremont, WA", "Fremont, Seattle, WA", "Fremont Washington"]) {
    expect((await searchPlaces(mongo.db, query)).map((item) => item.id)).toContain("fremont-seattle-wa");
  }
  expect(await searchPlaces(mongo.db, "Ballard", "OR")).toEqual([]);
  expect(await searchPlaces(mongo.db, "Ballard, Portland, OR")).toEqual([]);
  expect((await searchPlaces(mongo.db, "West Seattle, Washington"))[0]).toMatchObject({
    id: "west-seattle-seattle-wa", name: "West Seattle, Seattle, WA", kind: "neighborhood", geoid: null, branch_count: 4, system_count: 1,
  });
  expect(await searchPlaces(mongo.db, ".*")).toEqual([]);
  expect(await searchPlaces(mongo.db, "B")).toEqual([]);
  expect(await searchPlaces(mongo.db, "Ballard", undefined, 0)).toEqual([]);
});

it("onboards every reviewed community with only its branches and no borrowed Census identity", async () => {
  for (const [id, community] of Object.entries(communities)) {
    const location = await onboard(id);
    expect(location).toMatchObject({ id, census_geoid: null, community, latitude: community.latitude, longitude: community.longitude });
    expect(location.systems.flatMap((system) => system.branches.map((branch) => branch.name)).sort()).toEqual(community.library_branches.map((branch) => `${branch} Library`).sort());
  }
  const parent = await onboard("seattle-wa");
  expect(parent.census_geoid).toBe("5363000");
  expect(parent.community).toBeUndefined();
  expect(parent.systems[0].branches.map((branch) => branch.name)).toContain("Central Library");
  await updateSources(mongo.db, "ballard-seattle-wa", { WA0001: "https://manual.example/" }, null);
  expect((await onboard("ballard-seattle-wa")).systems[0].website).toBe("https://manual.example/");
  expect((await onboard("fremont-seattle-wa")).systems[0].website).toBe("https://library.example/");
});

it("prioritizes a reviewed neighborhood over a municipality with the same name", async () => {
  await mongo.db.collection<{ _id: string; name: string; name_lower: string; state: string }>("census_places").insertOne({
    _id: "fremont-ca", name: "Fremont", name_lower: "fremont", state: "CA",
  });
  expect((await searchPlaces(mongo.db, "Fremont", undefined, 1))[0].id).toBe("fremont-seattle-wa");
  expect((await searchPlaces(mongo.db, "Fremont, CA"))[0].id).toBe("fremont-ca");
});

it("keeps communities across Census refreshes and records missing branches without blocking onboarding", async () => {
  await searchPlaces(mongo.db, "Ballard");
  await importCensusPlaces(mongo.db, census());
  expect((await searchPlaces(mongo.db, "Ballard"))[0].id).toBe("ballard-seattle-wa");
  await mongo.db.collection("library_outlets").deleteMany({ type: "outlet", name: "BALLARD BRANCH LIBRARY" });
  const location = await onboard("ballard-seattle-wa");
  expect(location.systems).toEqual([]);
  expect(location.source_coverage?.gaps.join(" ")).toContain("Configured library branches missing");
  expect(() => communityDirectory({ bad: {} })).toThrow("communities entry bad");
  expect(() => communityDirectory({ "ballard-seattle-wa": { ...ballard, newsrooms: [{ name: "Unsafe", feed: "http://unsafe.example/" }] } })).toThrow("HTTPS");
});

it("filters shared library feeds by selected branches and isolates each community's cached links", async () => {
  const first = await onboard("ballard-seattle-wa");
  const second = await onboard("fremont-seattle-wa");
  const event = (branch: string) => ({ "@type": "Event", "@id": branch, name: `${branch} workshop`, startDate: "2026-10-23T15:00:00-07:00",
    url: `https://library.example/${branch.split(" ")[0]}`, location: { "@type": "Place", name: branch } });
  const replay = new ReplayTransport().on("https://library.example/", { body: `<script type="application/ld+json">${JSON.stringify([
    event("Ballard Branch"), event("Fremont Branch"), event("Central Library"),
  ])}</script>` });
  for (const location of [first, second]) {
    const [task] = libraryConnector.sources(location, settings);
    const collected = await libraryConnector.collect(task, context(replay, location));
    expect(collected.events).toHaveLength(1);
    expect(collected.events[0].branch).toBe(location.systems[0].branches[0].name);
    expect(collected.result.skipped_other_venues).toBe(2);
    expect(collected.result.link_discovery?.method).toBe("rules");
  }
  expect(await mongo.db.collection("connector_link_cache").countDocuments()).toBe(2);
});

it("uses the parent municipality for government lookup, not a neighborhood with a similar name", async () => {
  const replay = new ReplayTransport().on(/wikidata.org/, (request) => {
    const params = new URL(request.url).searchParams;
    if (params.get("action") === "wbsearchentities") return { body: { search: [] } };
    return { body: { entities: {} } };
  }).on(/legistar|civicclerk/, { status: 404, body: "" });
  await discoverGovernment(replay.transport, profile());
  const search = replay.requests.find((request) => new URL(request.url).searchParams.get("action") === "wbsearchentities");
  expect(new URL(search!.url).searchParams.get("search")).toBe("Seattle");
});

it("filters agendas before summarizing so a neighborhood item beyond the first five is retained", () => {
  const meeting: Meeting = { source_event_id: "1", body: "Seattle City Council", start: { year: 2026, month: 10, day: 23 },
    venue: "Ballard Branch", source_url: "https://council.example/1",
    items: [...Array.from({ length: 6 }, (_, index) => ({ title: `Citywide budget item ${index}` })), { title: "Ballard bridge repairs" }] };
  const scoped = scopeMeeting(meeting, profile());
  expect(scoped.items).toEqual([{ title: "Ballard bridge repairs" }]);
  expect(preview(scoped, "Seattle")?.title).toContain("Ballard bridge repairs");
  expect(scopeMeeting({ ...meeting, items: [{ title: "General city budget" }] }, profile()).items).toEqual([]);
  expect(scopeMeeting(meeting, { ...profile(), community: undefined })).toEqual(meeting);
});

it("scopes the meeting connector's actual collected output, including manual tenant links", async () => {
  const { collectMeetingLink } = await import("../../connectors/meetings");
  const { eventsUrl, itemsUrl } = await import("../../connectors/meetings/legistar");
  const government = { status: "override", platform: "legistar", tenant: "seattle", website: null, wikidata_id: null, pages_checked: [], detail: "test" };
  const location = { ...profile(), government };
  const replay = new ReplayTransport()
    .on(eventsUrl("seattle", "2026-10-12", "2026-10-26"), { body: [{ EventId: 1, EventBodyName: "Seattle City Council", EventDate: "2026-10-23T00:00:00", EventTime: "2:00 PM", EventInSiteURL: "https://council.example/1" }] })
    .on(itemsUrl("seattle", 1), { body: [{ EventItemTitle: "Ballard bridge repairs" }, { EventItemTitle: "Citywide office supplies" }] });
  const [task] = meetingsConnector.sources(location, settings);
  for (const collected of [await meetingsConnector.collect(task, context(replay, location)), await collectMeetingLink(context(replay, location), government)]) {
    expect(collected.events).toHaveLength(1);
    expect(collected.events[0].description).toContain("Ballard bridge repairs");
    expect(collected.events[0].description).not.toContain("office supplies");
  }
});

it.each([false, true])("inherits the parent's meeting tenant unless a community override exists (override: %s)", async (override) => {
  const { eventsUrl, itemsUrl } = await import("../../connectors/meetings/legistar");
  const tenant = override ? "ballard" : "seattle";
  await mongo.db.collection<{ _id: string; data: object }>("source_configs").insertOne({
    _id: "government-sources", data: {
      "seattle-wa": { platform: "legistar", tenant: "seattle" },
      ...(override ? { "ballard-seattle-wa": { platform: "legistar", tenant: "ballard" } } : {}),
    },
  });
  const replay = new ReplayTransport()
    .on(eventsUrl(tenant, "2026-10-12", "2026-10-26"), { body: [{ EventId: 1, EventBodyName: "Seattle City Council", EventDate: "2026-10-23T00:00:00", EventTime: "2:00 PM", EventInSiteURL: "https://council.example/1" }] })
    .on(itemsUrl(tenant, 1), { body: [{ EventItemTitle: "Ballard bridge repairs" }] });
  const location = profile();
  const [task] = meetingsConnector.sources(location, settings);
  const collected = await meetingsConnector.collect(task, context(replay));
  expect(collected.events).toHaveLength(1);
  expect(collected.result.feed_url).toContain(`/v1/${tenant}/`);
  expect(replay.requests.some((request) => request.url.includes("wikidata"))).toBe(false);
});

it("uses reviewed local RSS feeds and excludes city/county/nearby stories without community evidence", async () => {
  const location = profile();
  const region = resolveRegion(location, { WA: { name: "Washington", places: { Seattle: [47.6, -122.3] } } });
  expect(itemTier(region, "Seattle traffic update", "King County transport")).toBeNull();
  expect(trendTier(region, "Seattle news", "near Ballardish")).toBeNull();
  expect(itemTier(region, "Ballard bridge repairs", "")).toBe("local");
  expect(region.nearby).toEqual([]);
  const feed = `<rss><channel>${["Ballard bridge repairs", "Seattle office supplies", "King County budget"].map((title, index) =>
    `<item><title>${title}</title><link>https://news.example/${index}</link><pubDate>Sun, 18 Oct 2026 12:00:00 GMT</pubDate><description>${title}</description></item>`).join("")}</channel></rss>`;
  await mongo.db.collection<{ _id: string; data: object }>("source_configs").insertOne({ _id: "state-sources", data: {} });
  const replay = new ReplayTransport().on(ballard.newsrooms[0].feed, { body: feed });
  const [task] = stateNewsConnector.sources(location, settings);
  for (const source of [task, { ...task, params: { manual_feed: ballard.newsrooms[0].feed } }]) {
    const collected = await stateNewsConnector.collect(source, context(replay));
    expect(collected.result.status).toBe("ingested");
    expect(collected.events.map((event) => event.title)).toEqual(["Ballard bridge repairs"]);
    expect(collected.result.skipped_unusable.not_near_town).toBe(2);
  }
  expect(matchingCommunities(communities, "West Seattle, WA")).toHaveLength(1);
});
