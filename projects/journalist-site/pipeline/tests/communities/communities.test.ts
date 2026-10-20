import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { withMongo } from "../support/mongo";
import { importCensusPlaces, searchPlaces } from "../../communities/census";
import { importLibraryDirectory, placeId } from "../../communities/directory";
import { getLocation, listLocations, onboardLocation, removeLocation, updateSources, LocationBusy } from "../../communities/locations";
import type { GovernmentSource } from "../../connectors/types";
import { lookupWebsite, distanceKm, httpsOrigin } from "../../communities/wikidata";
import { matchBranch } from "../../communities/venues";

const mongo = withMongo();
const csvZip = (files: Record<string,string>) => zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));
const censusRows = [
  "GEOID\tUSPS\tNAME\tLSAD\tFUNCSTAT\tINTPTLAT\tINTPTLONG",
  "5363000\tWA\tSeattle city\t25\tA\t47.6038\t-122.3301",
  "5363010\tWA\tSeattle city\t25\tA\t47.60\t-122.33",
  "5369999\tWA\tSeattle CDP\t57\tS\t47.6\t-122.3",
  "4100000\tOR\tSmallville town\t43\tA\t45.0\t-123.0",
].join("\n");

it("imports incorporated Census places, deterministically deduplicating normalized IDs", async () => {
  const result = await importCensusPlaces(mongo.db, csvZip({ "2023_Gaz_place_national.txt": censusRows }));
  expect(result).toEqual({ places: 2, duplicates: 1 });
  const [seattle] = await searchPlaces(mongo.db, "Seattle");
  expect(seattle).toMatchObject({ id: "seattle-wa", name: "Seattle, WA", geoid: "5363000", latitude: 47.6038 });
  expect((await searchPlaces(mongo.db, "Small", "OR")).map((place) => place.id)).toEqual(["smallville-or"]);
  expect(await searchPlaces(mongo.db, "Seattle", "OR")).toEqual([]);
});

it("imports the IMLS systems/outlets and exposes CE/BR branches by normalized place ID", async () => {
  const systems = "STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,LATITUDE,LONGITUD\nWA,WA0001,SEATTLE PUBLIC LIBRARY,100 MAIN ST,SEATTLE,47.6,-122.3\n";
  const outlets = "STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,C_OUT_TY\nWA,WA0001,CENTRAL LIBRARY,100 MAIN ST,SEATTLE,CE\nWA,WA0001,MOBILE UNIT,1 VAN WAY,SEATTLE,BM\n";
  const counts = await importLibraryDirectory(mongo.db, csvZip({ "PLS_FY22_AE_pud22i.csv": systems, "pls_fy22_outlet_pud22i.csv": outlets }));
  expect(counts).toEqual({ systems: 1, outlets: 1, places: 1 });
  expect(placeId("SEATTLE", "WA")).toBe("seattle-wa");
  expect(await mongo.db.collection("library_outlets").countDocuments({ type: "outlet", place_id: "seattle-wa" })).toBe(1);
});

it("onboards an incorporated town with no library and supports managed source edits and safe removal", async () => {
  await importCensusPlaces(mongo.db, csvZip({ "2023_Gaz_place_national.txt": censusRows }));
  const government: GovernmentSource = { status: "no_platform", platform: null, tenant: null, website: null, wikidata_id: null, pages_checked: [], detail: "test" };
  const profile = await onboardLocation(mongo.db, async () => { throw new Error("town without a library must not call Wikidata"); }, "smallville-or", {
    settings: { root: process.cwd() }, overrides: {}, discoverGovernment: async () => government,
  });
  expect(profile).toMatchObject({ id: "smallville-or", name: "Smallville, OR", census_geoid: "4100000", state: "OR", systems: [], government });
  expect(await getLocation(mongo.db, profile.id)).toEqual(profile);
  expect((await listLocations(mongo.db)).map((item) => item.id)).toContain(profile.id);
  await updateSources(mongo.db, profile.id, {}, null);
  await mongo.db.collection("pipeline_jobs").insertOne({ location_id: profile.id, status: "running" });
  await expect(removeLocation(mongo.db, profile.id)).rejects.toBeInstanceOf(LocationBusy);
  await mongo.db.collection("pipeline_jobs").deleteMany({});
  await mongo.db.collection("connector_link_cache").insertOne({ location_id: profile.id });
  const removed = await removeLocation(mongo.db, profile.id);
  expect(removed).toMatchObject({ locations: 1, link_cache: 1 });
  await expect(getLocation(mongo.db, profile.id)).rejects.toThrow("not onboarded");
});

it("uses the Mongo source-config helper for reviewed library websites", async () => {
  await importCensusPlaces(mongo.db, csvZip({ "2023_Gaz_place_national.txt": censusRows }));
  const systems = "STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,LATITUDE,LONGITUD\nWA,WA0001,SEATTLE PUBLIC LIBRARY,100 MAIN ST,SEATTLE,47.6,-122.3\n";
  const outlets = "STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,C_OUT_TY\nWA,WA0001,CENTRAL LIBRARY,100 MAIN ST,SEATTLE,CE\n";
  await importLibraryDirectory(mongo.db, csvZip({ "PLS_FY22_AE_pud22i.csv": systems, "pls_fy22_outlet_pud22i.csv": outlets }));
  await mongo.db.collection<{ _id: string; config_path: string; data: Record<string, unknown> }>("source_configs").insertOne({ _id: "library-websites", config_path: "config/library-websites.json", data: { WA0001: { name: "Seattle Public Library", website: "https://www.spl.org/about/" } } });
  const profile = await onboardLocation(mongo.db, async () => { throw new Error("Mongo override should win before Wikidata"); }, "seattle-wa", { settings: { root: process.cwd() } });
  expect(profile.systems[0].website).toBe("https://www.spl.org/about/");
  expect(profile.systems[0].website_lookup?.detail).toBe("Website from config/library-websites.json");
});


it("matches venues by exact normalized branch name or address", () => {
  const branches = [{ name: "Capitol Hill Branch", address: "425 Harvard Ave E" }, { name: "Central Library", address: "1000 4th Ave" }];
  expect(matchBranch("The Capitol Hill Library", branches)).toBe("Capitol Hill Branch");
  expect(matchBranch("Meeting room, 425 Harvard Avenue East, Seattle", branches)).toBe("Capitol Hill Branch");
  expect(matchBranch("Capitol Hill Park", branches)).toBeNull();
});

it("resolves only nearby US Wikidata entities and upgrades websites to HTTPS", async () => {
  expect(distanceKm(47.6, -122.3, 47.61, -122.3)).toBeLessThan(50);
  expect(httpsOrigin("http://www.example.org/path/?tracking=1#section")).toBe("https://www.example.org/path/");
  const transport = async ({ url }: { url: string }) => {
    const action = new URL(url).searchParams.get("action");
    const data = action === "wbsearchentities"
      ? { search: [{ id: "Q1", label: "Example Library" }] }
      : { entities: { Q1: { claims: {
        P17: [{ mainsnak: { datavalue: { value: { id: "Q30" } } } }],
        P625: [{ mainsnak: { datavalue: { value: { latitude: 47.61, longitude: -122.3 } } } }],
        P856: [{ mainsnak: { datavalue: { value: "http://library.example/" } } }],
      } } } };
    return { url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(data)) };
  };
  const found = await lookupWebsite(transport, "Example Library", 47.6, -122.3);
  expect(found).toMatchObject({ status: "resolved", website: "https://library.example/", wikidata_id: "Q1" });
  const withoutCoordinates = await lookupWebsite(transport, "Example Library", null, -122.3);
  expect(withoutCoordinates.status).toBe("unresolved");
});

it("preserves manually managed websites and government disablement on re-onboarding", async () => {
  await importCensusPlaces(mongo.db, csvZip({ "2023_Gaz_place_national.txt": censusRows }));
  const systems = "STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,LATITUDE,LONGITUD\nWA,WA0001,SEATTLE PUBLIC LIBRARY,100 MAIN ST,SEATTLE,47.6,-122.3\n";
  const outlets = "STABR,FSCSKEY,LIBNAME,ADDRESS,CITY,C_OUT_TY\nWA,WA0001,CENTRAL LIBRARY,100 MAIN ST,SEATTLE,CE\n";
  await importLibraryDirectory(mongo.db, csvZip({ "PLS_FY22_AE_pud22i.csv": systems, "pls_fy22_outlet_pud22i.csv": outlets }));
  const initial = await onboardLocation(mongo.db, async ({ url }) => ({ url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ search: [] })) }), "seattle-wa", { settings: { root: process.cwd() }, overrides: {} });
  await updateSources(mongo.db, initial.id, { WA0001: "https://manual.example/" }, null);
  const refreshed = await onboardLocation(mongo.db, async ({ url }) => ({ url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ search: [] })) }), "seattle-wa", { settings: { root: process.cwd() }, overrides: {} });
  expect(refreshed.systems[0].website).toBe("https://manual.example/");
  expect(refreshed.government?.detail).toBe("Disabled in Journalist site");
});
