import { strToU8, zipSync } from "fflate";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Fetcher } from "../../connectors/fetcher";
import type { HttpTransport } from "../../core/http";
import { parseDistricts } from "../../communities/school-directory";
import { hubLinks, outsideLinks, siteLinks } from "../../discovery/inspect";
import { groupAddresses, METHODS, osmSection, type DiscoveryContext } from "../../discovery/methods";
import { districtIds, localSchools, schoolLinks } from "../../discovery/schools";
import { chooseLinks, scanSite, withoutSharedFeeds } from "../../discovery/site-pages";
import { nonScrapableReason } from "../../sourcemap/display";
import { categoryCoverage, saveSourceReview, sourceMap, SOURCE_REVIEWS, upsertCandidates, webSourceId, type SourceCandidate } from "../../sourcemap/store";
import { CATEGORIES, type SectionId } from "../../sourcemap/sections";
import { setting } from "../../playbook";

// The fake sites below have no DNS; the address check itself has its own tests.
vi.mock("../../connectors/public-http", async (original) => ({ ...await original<object>(), publicSourceTransport: (transport: HttpTransport) => transport }));

const page = (links: Array<[string, string]>) => links.map(([href, text]) => `<a href="${href}">${text}</a>`).join("\n");
const sectionsOf = (html: string, kind?: "government" | "school" | "organisation") => Object.fromEntries(siteLinks(html, "https://city.example.gov/", 40, kind).map((link) => [link.title, link.section]));

describe("sorting a site's links into sections", () => {
  it("puts a government's pages in the right section", () => {
    expect(sectionsOf(page([
      ["/agendas", "Agendas & Minutes"], ["/hearings", "Public Hearings"], ["/boards", "Boards and Commissions"], ["/police", "Police Department"], ["/fire", "Fire Department"],
      ["/permits", "Building Permits"], ["/licence", "Business License"], ["/econ", "Economic Development"], ["/volunteer", "Volunteer"], ["/parks", "Parks"], ["/cal", "Community Events"], ["/news", "City News"],
    ]))).toEqual({
      "Agendas & Minutes": "civic", "Public Hearings": "civic", "Boards and Commissions": "civic", "Police Department": "safety", "Fire Department": "safety",
      "Building Permits": "real_estate", "Business License": "business", "Economic Development": "business", Volunteer: "community", Parks: "community", "Community Events": "events", "City News": "news",
    });
  });

  it("files a public meeting under government, not events", () => {
    expect(sectionsOf(page([["/m", "Council Meetings"]]))).toEqual({ "Council Meetings": "civic" });
  });

  it("keeps a school's board, calendar and news in schools, and its athletics in sports", () => {
    expect(sectionsOf(page([["/board", "School Board Meetings"], ["/pta", "PTSA"], ["/calendar", "District Calendar"], ["/news", "District News"], ["/sports", "Athletics"]]), "school")).toEqual({
      "School Board Meetings": "schools", PTSA: "schools", "District Calendar": "schools", "District News": "schools", Athletics: "sports",
    });
  });

  it("files school athletics under sports, however the link is worded", () => {
    expect(sectionsOf(page([["/a", "Athletics Calendar"], ["/b", "Booster Club"], ["/c", "Athletic Boosters"], ["/d", "Sports News"]]), "school")).toEqual({
      "Athletics Calendar": "sports", "Booster Club": "sports", "Athletic Boosters": "sports", "Sports News": "sports",
    });
  });

  it("leaves arts boosters and a plain calendar in schools", () => {
    expect(sectionsOf(page([["/a", "Band Boosters"], ["/b", "Drama Boosters"], ["/c", "School Calendar"]]), "school")).toEqual({ "Band Boosters": "schools", "Drama Boosters": "schools", "School Calendar": "schools" });
  });

  it("skips one meeting or alert: its listing is the source", () => {
    expect(siteLinks(page([["/Calendar.aspx?EID=51", "City Council Regular Meeting"], ["/CivicAlerts.aspx?AID=15", "Public Hearing Notice"]]), "https://city.example.gov/")).toEqual([]);
  });

  it("gives every section a turn when the list is short", () => {
    const links = siteLinks(page([["/a", "Agendas"], ["/b", "Minutes"], ["/c", "Public Hearings"], ["/d", "Police"], ["/e", "Permits"]]), "https://city.example.gov/", 3);
    expect(new Set(links.map((link) => link.section))).toEqual(new Set(["civic", "safety", "real_estate"]));
  });

  it("finds hub pages to read for links", () => {
    expect(hubLinks(page([["/27/Government", "Government"], ["/8/Departments", "Departments"], ["/x", "Pay a bill"]]), "https://city.example.gov/")).toEqual(["https://city.example.gov/27/Government", "https://city.example.gov/8/Departments"]);
  });
});

describe("links leaving a site", () => {
  const html = page([["https://go.boarddocs.com/wa/x/Board.nsf/Public", "Board Meetings"], ["https://lakeside.legistar.com/", "Meetings"], ["http://lakesidechamber.org/", "Chamber of Commerce"], ["https://www.facebook.com/lakesidechamber", "Chamber of Commerce"], ["https://unitedwaylakeside.org", "United Way"], ["https://example.org/", "Weather"]]);

  it("finds meeting portals and local groups, and never a blocked platform", () => {
    const found = outsideLinks(html, "https://city.example.gov/", "government");
    expect(found.filter((link) => link.kind === "platform").map((link) => link.section)).toEqual(["civic", "civic"]);
    expect(found.filter((link) => link.kind === "group").map((link) => [link.url, link.section])).toEqual([["https://lakesidechamber.org/", "business"], ["https://unitedwaylakeside.org/", "community"]]);
  });

  it("files a school's meeting portal under schools", () => {
    expect(outsideLinks(html, "https://district.example.org/", "school").find((link) => link.url.includes("boarddocs"))?.section).toBe("schools");
  });
});

describe("choosing pages", () => {
  const link = (section: string, rank: number, name: string) => ({ url: `https://city.example.gov/${name}`, title: name, topic: null, section, rank });

  it("keeps the best of each section and scans for no weather", () => {
    const chosen = chooseLinks([link("civic", 2, "c"), link("civic", 0, "a"), link("civic", 1, "b"), link("civic", 2, "d"), link("civic", 2, "e"), link("weather", 0, "w")], {});
    expect(chosen.map((item) => item.title)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps a few sports pages on a site, after and on top of the rest", () => {
    const chosen = chooseLinks([link("sports", 7, "a"), link("sports", 7, "b"), link("sports", 7, "c"), link("civic", 0, "d"), link("safety", 3, "e")], { pages: 2 });
    expect(chosen.map((item) => item.title)).toEqual(["d", "e", "a", "b"]);
  });

  it("keeps no sports pages on a site read for other sections", () => {
    expect(chooseLinks([link("sports", 7, "a"), link("civic", 0, "b")], { sections: ["civic"] }).map((item) => item.title)).toEqual(["b"]);
  });

  it("adds a school's athletics pages after its board and PTA pages, without taking their places", () => {
    const links = [link("sports", 2, "athletics"), link("sports", 2, "teams"), link("schools", 1, "pta"), link("schools", 0, "board"), link("schools", 3, "calendar")];
    const school = { sections: ["schools"] as SectionId[], pages: 2, bestRank: 1, sportsPages: 1 };
    expect(chooseLinks(links, school).map((item) => item.title)).toEqual(["board", "pta", "athletics"]);
    expect(chooseLinks(links, {}).map((item) => item.title)).toEqual(["board", "pta", "calendar", "athletics", "teams"]);
  });

  it("honours a site's sections, page limit and rank limit", () => {
    const links = [link("civic", 0, "a"), link("safety", 3, "b"), link("events", 8, "c")];
    expect(chooseLinks(links, { sections: ["safety"] }).map((item) => item.title)).toEqual(["b"]);
    expect(chooseLinks(links, { pages: 1 }).map((item) => item.title)).toEqual(["a"]);
    expect(chooseLinks(links, { bestRank: 3 }).map((item) => item.title)).toEqual(["a", "b"]);
  });

  it("reaches the last-ranked sections of a busy site", () => {
    const busy = ["civic", "safety", "real_estate", "business", "events", "community", "news"].flatMap((section, rank) => [0, 1, 2, 3, 4].map((index) => link(section, rank, `${section}${index}`)));
    const chosen = chooseLinks(busy, {});
    expect(chosen).toHaveLength(17);
    expect(chosen.slice(0, 7).map((item) => item.section)).toEqual(["civic", "safety", "real_estate", "business", "events", "community", "news"]);
    expect(new Set(chooseLinks(busy, { pages: 7 }).map((item) => item.section)).size).toBe(7);
  });

  it("stops pages sharing a site-wide feed from becoming one source", () => {
    const candidate = (url: string, feed: string | null, section: "civic" | "safety"): SourceCandidate => ({ source_id: `web:${feed ?? url}`, name: url, url, feed_url: feed, reader: "web", params: { url, feed_url: feed }, section, found_by: { method: "government", detail: "" }, inside_area: false, source_kind: "feed" });
    const kept = withoutSharedFeeds([candidate("https://a.example/agendas", "https://a.example/feed", "civic"), candidate("https://a.example/police", "https://a.example/feed", "safety"), candidate("https://a.example/own", "https://a.example/own.rss", "civic")]);
    expect(kept).toHaveLength(3);
    expect(new Set(kept.map((item) => item.source_id)).size).toBe(3);
    expect(kept.map((item) => item.feed_url)).toEqual([null, null, "https://a.example/own.rss"]);
  });
});

describe("school districts", () => {
  it("reads every kind of district from the Census answer", () => {
    expect(districtIds({ result: { geographies: { "Unified School Districts": [{ NAME: "Lakeside School District", GEOID: "0100001" }], "Elementary School Districts": [{ NAME: "Elm", GEOID: "0100002" }], Counties: [{ NAME: "Grant", GEOID: "1" }] } } }).map((row) => row.id)).toEqual(["0100001", "0100002"]);
  });

  it("reads the directory file, skipping districts with no website and closed ones", () => {
    const csv = "LEAID,LEA_NAME,ST,WEBSITE,SY_STATUS\n0100001,Lakeside School District,WA,http://www.lakeside.example,1\n0100002,No Site,WA,,1\n0100003,Closed,WA,closed.example,2\n0100004,Bare Address,WA,bare.example.org,1\n";
    expect(parseDistricts(zipSync({ "lea.csv": strToU8(csv), "lea.sas7bdat": strToU8("binary") })).map((row) => [row._id, row.website])).toEqual([["0100001", "https://www.lakeside.example"], ["0100004", "https://bare.example.org"]]);
  });

  it("reads schools from a district's links", () => {
    expect(schoolLinks([["https://d.example.org/schools", page([["/north", "North Elementary"], ["/lake", "Lakeside High School"], ["/board", "School Board"]])]]).map((school) => school.url)).toEqual(["https://d.example.org/north", "https://d.example.org/lake"]);
  });

  it("keeps a neighbourhood to the schools inside it", () => {
    const linked = [{ name: "North Elementary", url: "https://d.example.org/north" }, { name: "Far Elementary", url: "https://d.example.org/far" }];
    const known = [{ name: "North Elementary School", website: null, inside: true }, { name: "Far Elementary", website: null, inside: false }];
    expect(localSchools(linked, known, true, 6).map((school) => school.name)).toEqual(["North Elementary"]);
    expect(localSchools(linked, known, false, 6)).toHaveLength(2);
  });
});

describe("OpenStreetMap groups", () => {
  it("sorts association offices by what their name says they are", () => {
    expect(osmSection("association", "Lakeside Chamber of Commerce")).toBe("business");
    expect(osmSection("ngo", "North Elementary PTA")).toBe("schools");
    expect(osmSection("charity", "Lakeside Food Bank")).toBe("community");
    expect(osmSection("fire_station", "Lakeside Downtown Fire Station")).toBe("safety");
    expect(osmSection("sports_centre", "Lakeside Sports Centre")).toBe("sports");
    expect(setting("sports.prefer.athletics_association_section")).toBe("sports");
  });
});

describe("usual addresses", () => {
  it("are built only from the place's own name", () => {
    const hosts = groupAddresses("Lake Side", "North Gate").flatMap((group) => group.hosts);
    expect(hosts).toContain("lakesidechamber.org");
    expect(hosts).toContain("northgatecommunitycouncil.org");
    for (const host of hosts) expect(host, host).toMatch(/lakeside|northgate/);
  });
});

describe("with a database", () => {
  let server: MongoMemoryServer, client: MongoClient, db: Db;
  beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("category-pages"); });
  beforeEach(async () => { await db.dropDatabase(); });
  afterAll(async () => { await client?.close(); await server?.stop(); });

  const web = (path: string, extra: Partial<SourceCandidate> = {}): SourceCandidate => ({ source_id: `web:${path}`, name: path, url: `https://city.example.gov/${path}`, reader: "web", params: {}, section: "civic", found_by: { method: "government", detail: "" }, inside_area: false, ...extra });

  it("keeps a site's checked section pages, and still limits copies of it", async () => {
    await upsertCandidates(db, "loc", [web("a"), web("b"), web("c"), web("d", { section_page: true }), web("e", { section_page: true })]);
    const saved = (await sourceMap(db).find({ location_id: "loc" }).toArray()).map((row) => row.source_id).sort();
    expect(saved).toEqual(["web:a", "web:b", "web:d", "web:e"]);
    expect((await sourceMap(db).findOne({ source_id: "web:d" }))).not.toHaveProperty("section_page");
  });

  it("reports each category, and doesn't let a national reader hide an empty one", async () => {
    await upsertCandidates(db, "loc", [web("a", { section_page: true }), web("b", { section_page: true, link_only: true }), { ...web("n"), source_id: "remembrance:loc", url: null, reader: "remembrance", section: "obituaries", found_by: { method: "national", detail: "" } }]);
    const rows = await categoryCoverage(db, "loc");
    expect(rows.map((row) => row.category)).toEqual([...CATEGORIES]);
    expect(rows.find((row) => row.category === "civic")).toMatchObject({ found: 2, readable: 1, link_only: 1, empty: false });
    expect(rows.find((row) => row.category === "obituaries")).toMatchObject({ found: 0, built_in: 1, empty: true });
    expect(rows.find((row) => row.category === "sports")).toMatchObject({ found: 0, empty: true });
    expect(CATEGORIES).not.toContain("weather");
  });

  describe("with human labels", () => {
    const pageUrl = "https://city.example.gov/agendas";
    const checked = (extra: Partial<SourceCandidate> = {}): SourceCandidate => ({ ...web("agendas", { source_id: webSourceId(pageUrl), url: pageUrl, section_page: true, source_kind: "document_list", status: "active" }), ...extra });

    it("keeps a label and status when a fixed run finds the page again, and refreshes its details", async () => {
      await upsertCandidates(db, "loc", [checked({ link_only: true, why: "No current dated items found, possibly built by script: kept as a link for an editor" })]);
      await saveSourceReview(db, "loc", webSourceId(pageUrl), { decision: "accept", reason: "The real agenda page" }, "editor@example.test");
      await upsertCandidates(db, "loc", [checked({ link_only: true, name: "Agendas, renamed", why: "No current dated items found, possibly built by script: kept as a link for an editor" })]);
      const saved = await sourceMap(db).findOne({ source_id: webSourceId(pageUrl) });
      expect(saved).toMatchObject({ status: "active", link_only: true, name: "Agendas, renamed", review: { decision: "accept", reason: "The real agenda page", initial_status: "active" } });
      expect(saved).not.toHaveProperty("section_page");
      expect(nonScrapableReason(saved!)).toBe("No current dates found");
      expect(await db.collection(SOURCE_REVIEWS).findOne({ source_id: webSourceId(pageUrl) })).toMatchObject({ link_only: true, non_scrapable_reason: "No current dates found" });
    });

    it("keeps a rejected page rejected, and out of the category count", async () => {
      await upsertCandidates(db, "loc", [checked()]);
      await saveSourceReview(db, "loc", webSourceId(pageUrl), { decision: "reject", reason: "Not an agenda" }, "editor@example.test");
      await upsertCandidates(db, "loc", [checked()]);
      expect(await sourceMap(db).findOne({ source_id: webSourceId(pageUrl) })).toMatchObject({ status: "rejected", review: { decision: "reject" } });
      expect((await categoryCoverage(db, "loc")).find((row) => row.category === "civic")).toMatchObject({ found: 0, empty: true });
    });

    it("doesn't bring back a rejected page because its feed came or went", async () => {
      const feed = "https://city.example.gov/feed";
      await upsertCandidates(db, "loc", [checked()]);
      await saveSourceReview(db, "loc", webSourceId(pageUrl), { decision: "reject" }, "editor@example.test");
      await upsertCandidates(db, "loc", [checked({ source_id: webSourceId(feed), feed_url: feed })]);
      expect(await sourceMap(db).countDocuments({ location_id: "loc" })).toBe(1);

      await sourceMap(db).deleteMany({});
      await upsertCandidates(db, "loc", [checked({ source_id: webSourceId(feed), feed_url: feed })]);
      await saveSourceReview(db, "loc", webSourceId(feed), { decision: "reject" }, "editor@example.test");
      await upsertCandidates(db, "loc", [checked()]);
      expect(await sourceMap(db).countDocuments({ location_id: "loc" })).toBe(1);
    });

    it("rejecting one of a site's feeds leaves its other feeds alone", async () => {
      const feedSource = (name: string): SourceCandidate => web(name, { source_id: webSourceId(`https://city.example.gov/${name}.rss`), url: "https://city.example.gov", feed_url: `https://city.example.gov/${name}.rss`, section_page: true });
      await upsertCandidates(db, "loc", [feedSource("news")]);
      await saveSourceReview(db, "loc", feedSource("news").source_id, { decision: "reject" }, "editor@example.test");
      await upsertCandidates(db, "loc", [feedSource("calendar")]);
      expect(await sourceMap(db).countDocuments({ location_id: "loc" })).toBe(2);
    });
  });

  it("finds a council's agendas through a hub page, as active sources in the right sections, and respects robots", async () => {
    const today = "2026-11-06";
    const listing = (title: string) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${"Lakeside city record. ".repeat(30)}</p><ul><li>November 2, 2026</li><li>October 19, 2026</li><li>October 5, 2026</li></ul></main></body></html>`;
    const pages: Record<string, string> = {
      "/": `<html><head><title>City of Lakeside</title></head><body>${page([["/government", "Government"], ["/police", "Police Department"], ["/parks", "Parks"]])}</body></html>`,
      "/government": `<html><body>${page([["/agendas", "Agendas and Minutes"], ["/private-permits", "Building Permits"], ["https://lakeside.primegov.com/public/portal", "Meeting Portal"]])}</body></html>`,
      "/agendas": listing("Agendas and Minutes"), "/police": listing("Police Department"),
      "/parks": `<html><head><title>Parks</title></head><body><main><h1>Parks</h1><p>${"Lakeside parks and trails. ".repeat(30)}</p></main></body></html>`,
    };
    const transport: HttpTransport = async (request) => {
      const url = new URL(request.url);
      const send = (status: number, text: string, type = "text/html") => ({ url: request.url, status, headers: { "content-type": type }, body: new TextEncoder().encode(text) });
      if (url.pathname === "/robots.txt") return send(200, "User-agent: *\nDisallow: /private-permits\n", "text/plain");
      if (url.hostname === "city.example.gov" && pages[url.pathname]) return send(200, pages[url.pathname]);
      return send(404, "not here");
    };
    const context = { db, settings: { integrations: {} }, transport, fetcher: new Fetcher(transport, undefined, false), location: { id: "loc", name: "Lakeside, WA", state: "WA", systems: [], government: null }, today, log: { info() {}, warn() {} } } as unknown as DiscoveryContext;
    const scan = await scanSite(context, { url: "https://city.example.gov/", name: "City of Lakeside", kind: "government", scope: "place" }, "government", new Set(), Date.now() + 20_000);
    const byPath = Object.fromEntries(scan.candidates.map((candidate) => [new URL(candidate.url!).pathname, candidate]));
    expect(byPath["/agendas"]).toMatchObject({ section: "civic", status: "active", section_page: true, link_only: false, topics: ["government"] });
    expect(byPath["/police"]).toMatchObject({ section: "safety", status: "active", link_only: false });
    expect(byPath["/private-permits"]).toMatchObject({ section: "real_estate", link_only: true, access: { robots: "blocked" } });
    // The source network explains each link-only page from what the check stored.
    expect(nonScrapableReason(byPath["/private-permits"])).toBe("Blocked from reading");
    expect(byPath["/parks"]).toMatchObject({ section: "community", link_only: true });
    expect(nonScrapableReason(byPath["/parks"])).toBe("No current dates found");
    expect(nonScrapableReason(byPath["/agendas"])).toBeNull();
  });

  it("registers the new methods in the fixed flow", () => {
    expect(METHODS.map((method) => method.method)).toEqual(expect.arrayContaining(["schools", "groups"]));
  });
});
