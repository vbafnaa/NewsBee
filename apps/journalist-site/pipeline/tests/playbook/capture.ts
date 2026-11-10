/**
 * What the scrapers do with their rules, captured as data. `golden.json` was written by this file
 * on origin/main, before any rule moved to the playbook, so a difference from it is a changed rule.
 * Every place below is made up. Timestamps are removed; the mapping skill's text is replaced by a
 * marker, because the AI's added text is the one intended change and has its own test.
 */
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { mappingSkill } from "../../agent/skill";
import { agentJob, CELL_DRY, CELL_DRY_DORK, ROUND_PROPOSALS, TRIAGE_CATEGORIES, TRIAGE_RESULTS, withoutGuessedSites, type AgentState } from "../../agent/map-sources";
import { Fetcher } from "../../connectors/fetcher";
import { aggregator } from "../../connectors/newssearch";
import type { LocationProfile } from "../../connectors/types";
import type { Settings } from "../../core/config";
import type { HttpTransport } from "../../core/http";
import { PRIORITY_TOPICS, resolveRunOptions, withRunContext, type PriorityTopic } from "../../core/run-options";
import { governmentScore } from "../../discovery/city-site";
import { datasetOf, hubLinks, inspectPage, outsideLinks, RECENT_DAYS, siteLinks, type SiteKind, type SiteLink } from "../../discovery/inspect";
import { groupAddresses, INSTITUTION_TOPICS, matchPortals, methodDefinition, OSM_CAP, OSM_SECTION_CAP, osmSection, PUBLISHER_MIN_HITS, type DiscoveryContext } from "../../discovery/methods";
import { localSchools, schoolLinks } from "../../discovery/schools";
import { chooseLinks } from "../../discovery/site-pages";
import { stage1Queries, stage2Queries, TOPIC_KINDS, TOPIC_SECTIONS, type SearchKit } from "../../discovery/topics";
import { classify, ruleTier } from "../../search/classifier";
import { search, searchQueries, tavilyRequest } from "../../search/provider";
import { paidRefusal } from "../../trace/gateway";
import { keywordSection, KIND_SECTIONS, sectionFor } from "../../sourcemap/sections";
import { FakeModel } from "../support/fake-model";

const TOPICS = PRIORITY_TOPICS.map((topic) => topic.id);
const institution = (name: string, kind: string, website: string | null = null) => ({ name, kind, website, inside: true });

export const KITS: Record<string, SearchKit> = {
  neighbourhood: {
    place: "Northgate", parent: "Lakeside", state: "Washington", stateCode: "WA", county: "Grant", cityDomain: "city.example.gov", zips: ["98000"],
    schools: [1, 2, 3, 4].map((n) => ({ name: `North ${n} High School`, host: `north${n}.example.org` })),
    institutions: [institution("Valley Funeral Chapel", "funeral_directors"), institution("Hill Mortuary", "funeral_directors"), institution("Third Chapel", "funeral_directors"), institution("Branch Library", "library"), institution("Arts Barn", "arts_centre"), institution("Old Theatre", "theatre"), institution("Rowing Club", "club"), institution("Swim Club", "club"), institution("Site Library", "library", "https://lib.example.org/")],
    venues: ["Riverside Hall", "Pier Stage", "Third Venue"], agencyHosts: ["police.example.gov", "sheriff.example.gov", "third.example.gov"], funeralHosts: ["chapel.example.com", "mortuary.example.com", "third.example.com"],
    schoolHosts: ["north1.example.org", "north2.example.org", "north3.example.org"], teamHosts: ["team1.example.org", "team2.example.org", "team3.example.org"], savedHosts: ["city.example.gov"], associationHost: "association.example.org",
  },
  town: {
    place: "Fernhollow", parent: null, state: "Oregon", stateCode: "OR", county: "Marsh", cityDomain: "fernhollow.example.us", zips: [],
    schools: [{ name: "Fernhollow Academy", host: null }], institutions: [], venues: [], agencyHosts: [], funeralHosts: [], schoolHosts: [], teamHosts: [], savedHosts: [], associationHost: null,
  },
  sparse: { place: "Stonebrook", parent: null, state: "Ohio", stateCode: "OH", county: null, cityDomain: null, zips: [], schools: [], institutions: [], venues: [], agencyHosts: [], funeralHosts: [], schoolHosts: [], teamHosts: [], savedHosts: [], associationHost: null },
};

function queries() {
  const out: Record<string, unknown> = {};
  for (const [name, kit] of Object.entries(KITS)) {
    out[`${name}:stage1:all:66`] = stage1Queries(kit, [...TOPICS], 66);
    out[`${name}:stage1:all:500`] = stage1Queries(kit, [...TOPICS], 500);
    out[`${name}:stage1:two:9`] = stage1Queries(kit, ["crime", "sports"], 9);
    for (const topic of TOPICS) {
      out[`${name}:stage1:${topic}:50`] = stage1Queries(kit, [topic], 50);
      out[`${name}:stage2:${topic}:default`] = stage2Queries(kit, topic, "2026-10-01");
      out[`${name}:stage2:${topic}:50`] = stage2Queries(kit, topic, "2026-10-01", 50);
    }
  }
  return out;
}

const ITEMS = [
  "Things to do this weekend in town", "Your agenda this week", "What's happening downtown", "Weekend guide to the fair", "Community calendar", "Events in the park", "Obituary: a long life", "She passed away on Monday",
  "Celebration of life planned", "Memorial service set", "In loving memory", "Funeral notice", "He died in a crash", "Wedding anniversary marked", "Neighbour turns 100", "Police arrest suspect", "Sheriff report", "Two-car collision", "Kitchen fire", "Shooting investigated",
  "Stabbing downtown", "Burglary at the mall", "Theft reported", "Robbery suspect", "911 outage", "Medics respond", "Aid response call", "Rescue at the lake", "Crime rates fall", "Missing person found", "Man charged with fraud", "Court date set",
  "Weather warning", "Storm coming", "Windstorm damage", "Flood watch", "Heat wave ahead", "Smoke in the air", "Air quality alert", "Road advisory", "Snow closes roads", "King tide floods road", "Earthquake felt", "Power outage hits", "Athletic director named", "Varsity win",
  "Football scores", "Soccer team wins", "Basketball tournament", "Volleyball finals", "Baseball opener", "Softball sweep", "Wrestling meet", "Swim meet results", "Track and field day", "Cross country race", "Playoff bound", "Final score", "Hawks defeated Owls", "League game on Friday",
  "Real estate market cools", "Home sale record", "House sold for a million", "New listing", "Permit approved", "Zoning change", "Rezone request", "Land use notice", "New development", "Construction starts", "Housing plan", "Apartment tower", "Townhome project", "Parcel split", "Demolition set", "Single-family homes",
  "School opens late", "Student wins prize", "Teacher of the year", "PTA meeting", "PTSA fundraiser", "Graduation day", "Scholarship winners", "National Merit list", "Homecoming parade", "Youth group trip", "Kids camp", "City council votes", "Planning commission", "School board meets", "New ordinance", "City budget", "County levy",
  "Election night", "Public hearing", "Mayor speaks", "Legislature session", "Public comment", "311 calls rise", "Code enforcement sweep", "Now open on Main", "Grand opening", "Cafe opens", "Bakery closes", "Brewery expands", "Corner shop", "New store", "Local business", "Liquor license", "Licence granted", "Restaurant inspection", "Layoff at plant", "Ribbon cutting",
  "Street festival", "Summer concert", "Farmers market", "County fair", "Pottery class", "Writing workshop", "Library storytime", "Garden tour", "Art exhibit", "Film screening", "Charity walk", "Fun run", "Book meetup", "Celebrate spring", "Holiday parade", "Park cleanup", "Volunteer day", "Neighbor helps", "Neighbour news", "Community council", "Garden association", "Good deed", "Local hero", "Chess club", "Nothing to file here",
];
const KINDS = ["event", "meeting_preview", "meeting_outcome", "state_news", "earthquake", "weather_alert", "safety_notice", "trending_topic", "social_trend", "housing_market", "development", "home_sale", "building_permit", "school_sports", "game_result", "court_case", "safety_incident", "local_news", "news_report", "business_opening", "public_record", "obituary", "reader_story", "unknown_kind"];

const URLS = ["https://www.city.example.gov/", "https://www.example.us/", "https://base.example.mil/", "https://data.example.com/", "https://city.example.com/", "https://county.example.net/", "https://sd.k12.example.us/", "https://college.example.edu/", "https://example.gov.uk/",
  "https://westptsa.example.net/", "https://pta-west.example.net/", "https://pto.example.net/", "https://valley-times.example.com/", "https://herald.example.org/", "https://gazette.example.com/", "https://mytribune.example.net/", "https://journal.example.com/", "https://post.example.com/", "https://blog.example.com/",
  "https://press.example.com/", "https://courier.example.com/", "https://chronicle.example.com/", "https://observer.example.com/", "https://sentinel.example.com/", "https://examiner.example.com/", "https://weekly.example.com/", "https://daily.example.com/", "https://lakeside.patch.com/", "https://www.newsbreak.com/a", "https://www.msn.com/a",
  "https://news.yahoo.com/a", "https://ground.news/a", "https://flipboard.com/a", "https://www.aol.com/a", "https://smartnews.example.com/", "https://newsbreakapp.example.com/", "https://www.nytimes.com/a", "https://www.yelp.com/biz", "https://youtube.com/w", "https://club.example.org/", "https://parish.church/", "https://giving.foundation/", "https://shop.example.com/", "https://shop.wordpress.com/"];
const TITLES = ["", "West PTSA", "North PTO news", "Parent-teacher group", "Valley News", "The Times", "Daily deals"];

const LINKS: Array<[string, string]> = [["/agendas", "Agendas & Minutes"], ["/center", "Agenda Center"], ["/public-meetings", "Public Meetings"], ["/portal", "Meeting Portal"], ["/videos", "Meeting Videos"], ["/hearings", "Public Hearings"], ["/examiner", "Hearing Examiner"], ["/notices", "Legal Notices"], ["/boards", "Boards and Commissions"], ["/advisory", "Advisory Committees"], ["/planning-commission", "Planning Commission"],
  ["/council", "City Council"], ["/county-council", "County Council"], ["/commissioners", "County Commissioners"], ["/members", "Councilmembers"], ["/hall", "Town Hall"], ["/legislation", "Legislation"], ["/police", "Police Department"], ["/sheriff", "Sheriff"], ["/blotter", "Blotter"], ["/crime", "Crime Map"], ["/incidents", "Incidents"], ["/safety", "Public Safety"], ["/fire", "Fire"], ["/emergency", "Emergency Management"], ["/911", "911"],
  ["/obits", "Obituaries"], ["/memorials", "Memorials"], ["/tributes", "Tributes"], ["/services", "Recent Services"], ["/permits", "Building Permits"], ["/landuse", "Land Use"], ["/assessor", "Assessor"], ["/zoning", "Zoning"], ["/recorder", "Recorder"], ["/propertysearch", "Property Search"], ["/devnotices", "Development Notices"], ["/commdev", "Community Development"], ["/planning", "Planning"], ["/buildingdept", "Building Department"], ["/housing", "Housing"],
  ["/licence", "Business License"], ["/econ", "Economic Development"], ["/bizdir", "Business Directory"], ["/start", "Starting a Business"], ["/newbiz", "New Businesses"], ["/chamber", "Chamber of Commerce"], ["/dtown", "Downtown Alliance"], ["/mainst", "Main Street"], ["/shoplocal", "Shop Local"], ["/athletics", "Athletics"], ["/sports", "Sports"], ["/teams", "Teams"], ["/standings", "Standings"], ["/scores", "Scores"], ["/league", "League"], ["/games", "Game Schedule"],
  ["/calendar", "Calendar"], ["/events", "Community Events"], ["/festivals", "Festivals"], ["/programs", "Programs"], ["/classes", "Classes"], ["/rec", "Recreation"], ["/todo", "Things to Do"], ["/volunteer", "Volunteer"], ["/involved", "Get Involved"], ["/neighborhoods", "Neighborhoods"], ["/groups", "Community Groups"], ["/center-c", "Community Centers"], ["/nonprofits", "Nonprofits"], ["/projects", "Projects"], ["/cip", "Capital Improvements"], ["/transport", "Transportation"], ["/advisories", "Service Advisories"], ["/parks", "Parks"], ["/library", "Library"],
  ["/news", "City News"], ["/newsroom", "Newsroom"], ["/press", "Press Releases"], ["/announcements", "Announcements"], ["/alerts", "Alerts"], ["/blog", "Blog"], ["/school-board", "School Board"], ["/bod", "Board of Directors"], ["/boe", "Board of Education"], ["/bm", "Board Meetings"], ["/boarddocs", "BoardDocs"], ["/ptsa", "PTSA"], ["/pto", "PTO"], ["/ptg", "Parent-Teacher Group"], ["/boosters", "Boosters"], ["/bulletins", "Bulletins"], ["/nothing", "Pay a bill"],
  ["/Calendar.aspx?EID=51", "City Council Meeting"], ["/CivicAlerts.aspx?AID=15", "Public Hearing Notice"], ["/2026/10/story", "News story"], ["/a-very-long-story-slug-with-many-words-here", "News"], ["/file.pdf", "Agendas PDF"]];
const HUBS: Array<[string, string]> = ["Government", "Departments", "Your City", "City Hall", "Services", "Residents", "Community", "Business", "Schools", "Our Schools", "Families", "Parents", "District", "I Want To", "Sitemap", "Site Map", "Pay a bill", "A very long title that mentions government and runs past the limit"].map((title, index) => [`/hub${index}`, title]);
const OUTSIDE: Array<[string, string]> = [["https://x.legistar.com/", "Meetings"], ["https://x.civicclerk.com/", "M"], ["https://x.primegov.com/", "M"], ["https://x.granicus.com/", "M"], ["https://x.iqm2.com/", "M"], ["https://x.novusagenda.com/", "M"], ["https://x.municodemeetings.com/", "M"], ["https://x.escribemeetings.com/", "M"], ["https://x.civicweb.net/", "M"], ["https://go.boarddocs.com/", "M"], ["https://x.eboardsolutions.com/", "M"], ["https://x.highbond.com/", "M"], ["https://x.boardbook.org/", "M"], ["https://x.agendaonline.net/", "M"], ["https://x.destinyhosted.com/", "M"],
  ["https://a.example.org/", "West PTSA"], ["https://b.example.org/", "parent-teacher group"], ["https://c.example.org/", "Lakeside School District"], ["https://d.example.org/", "Public Schools"], ["https://e.example.org/", "Chamber of Commerce"], ["https://f.example.org/", "Downtown Lakeside Association"], ["https://g.example.org/", "Business Improvement Area"], ["https://h.example.org/", "Main Street Program"], ["https://i.example.org/", "Economic Development Council"], ["https://j.example.org/", "United Way"], ["https://k.example.org/", "Volunteer Hub"], ["https://l.example.org/", "Community Council"], ["https://m.example.org/", "Neighborhood Association"], ["https://n.example.org/", "Food Bank"], ["https://o.example.org/", "Rotary"], ["https://p.example.org/", "Kiwanis"], ["https://q.example.org/", "Lions Club"], ["https://r.example.org/", "Historical Society"], ["https://lakesidechamber.example.org/", "Home"], ["https://s.example.org/", "Community Council with a name far too long to be a link title at all, running past eighty letters"], ["https://www.facebook.com/x", "Chamber of Commerce"]];
const anchors = (links: Array<[string, string]>) => links.map(([href, text]) => `<a href="${href}">${text}</a>`).join("\n");

const OSM_NAMES = ["Lakeside Chamber", "Downtown Group", "Main Street Trust", "Merchants Guild", "Business Association", "West PTA", "North PTSA", "South PTO", "Parent-Teacher Circle", "Food Bank", "Economic Development Board"];
const OSM_KIND_LIST = ["townhall", "government", "police", "fire_station", "courthouse", "library", "community_centre", "marketplace", "social_centre", "school", "college", "university", "arts_centre", "theatre", "museum", "newspaper", "association", "ngo", "charity", "foundation", "social_facility", "place_of_worship", "funeral_directors", "park", "sports_centre"];

const PAGES: Record<string, string> = {
  government: "<html><head><title>City of Lakeside</title></head><body>Lakeside city council and mayor. Agendas, minutes, departments, city hall, permits. Official website.</body></html>",
  three: "<html><head><title>Lakeside</title></head><body>Lakeside town council, town manager, agendas.</body></html>",
  two: "<html><head><title>Lakeside</title></head><body>Lakeside council meeting agenda departments? no</body></html>",
  chamber: "<html><head><title>Lakeside Chamber of Commerce</title></head><body>Lakeside city council mayor agendas departments permits</body></html>",
  visit: "<html><head><title>Visit Lakeside</title></head><body>Lakeside city council mayor agendas departments permits</body></html>",
  other: "<html><head><title>Elsewhere</title></head><body>City council mayor agendas departments permits</body></html>",
};
const INSPECT: Record<string, string> = {
  listing: "<main><p>Item</p><ul><li>November 2, 2026</li><li>October 19, 2026</li><li>October 5, 2026</li></ul></main>",
  old: "<main><ul><li>January 2, 2024</li><li>March 19, 2024</li><li>May 5, 2024</li></ul></main>",
  documents: '<main><a href="/a.pdf">a</a><a href="/b.pdf">b</a><a href="/DocumentCenter/View/1">c</a></main>',
  twoDocuments: '<main><a href="/a.pdf">a</a><a href="/AgendaCenter/ViewFile/2">b</a></main>',
  embedded: '<main><iframe src="https://public.tableau.com/x"></iframe></main>',
  powerbi: "<main>https://app.powerbi.com/view</main>", arcgis: "<main>experience.arcgis.com</main>",
  form: "<form><input></form><main>Enter your parcel number. Search by address.</main>", formLookup: "<form></form><main>Look up an account number</main>", formNot: "<form></form><main>Contact us today</main>",
};

function pure() {
  const kinds: SiteKind[] = ["government", "school", "organisation"];
  const links = (kind: SiteKind) => siteLinks(anchors(LINKS), "https://city.example.gov/", 500, kind);
  const many = links("government") as SiteLink[];
  return {
    limits: { RECENT_DAYS, OSM_CAP, OSM_SECTION_CAP, PUBLISHER_MIN_HITS, CELL_DRY, CELL_DRY_DORK, ROUND_PROPOSALS, TRIAGE_CATEGORIES, TRIAGE_RESULTS },
    maps: { TOPIC_SECTIONS, TOPIC_KINDS, INSTITUTION_TOPICS, KIND_SECTIONS },
    keywordSection: Object.fromEntries(ITEMS.map((text) => [text, keywordSection(text)])),
    sectionFor: KINDS.flatMap((kind) => ITEMS.slice(0, 200).filter((_, index) => index % 9 === 0).map((title) => [kind, title, sectionFor({ kind, title }), sectionFor({ kind, title: "Nothing to file here" }, "business")])),
    sectionForExplicit: [sectionFor({ title: "x", section_id: "news" }), sectionFor({ title: "Nothing", section_id: "nope" })],
    ruleTier: URLS.flatMap((url) => TITLES.map((title) => [url, title, ruleTier(url, title)])),
    aggregator: URLS.map((url) => [url, aggregator(url)]),
    siteLinks: Object.fromEntries(kinds.map((kind) => [kind, links(kind)])),
    siteLinksCap8: siteLinks(anchors(LINKS), "https://city.example.gov/"),
    hubLinks: hubLinks(anchors(HUBS), "https://city.example.gov/", 50),
    hubLinksDefault: hubLinks(anchors(HUBS), "https://city.example.gov/"),
    outsideLinks: Object.fromEntries(kinds.map((kind) => [kind, outsideLinks(anchors(OUTSIDE), "https://city.example.gov/", kind)])),
    chooseLinks: { all: chooseLinks(many, {}), county: chooseLinks(many, { sections: ["civic", "safety", "real_estate"], pages: 6 }), best: chooseLinks(links("school"), { bestRank: 1, sections: ["schools"], pages: 2 }), school: chooseLinks(links("school"), {}) },
    osmSection: OSM_KIND_LIST.flatMap((kind) => OSM_NAMES.map((name) => [kind, name, osmSection(kind, name)])),
    groupAddresses: groupAddresses("Lake Side", "North Gate").map((group) => ({ ...group, proof: String(group.proof) })),
    matchPortals: matchPortals(["data.lakeside.gov", "lakeside.example.gov", "cityoflakeside.example.gov", "lakesidewa.example.gov", "lakesidegov.example.org", "data.grantcounty.gov", "grantcountywa.example.gov", "data.wa.gov", "data.washington.gov", "data.other.gov", "a.b.c.wa.gov"], { id: "l", name: "Lakeside, WA", state: "WA", systems: [], government: null } as unknown as LocationProfile, "Grant County"),
    governmentScore: Object.fromEntries(Object.entries(PAGES).flatMap(([name, html]) => ["https://lakeside.example.com/", "https://lakeside.example.gov/", "https://cityoflakeside.example.com/", "https://ci.lakeside.example.org/", "https://lakeside.example.us/"].map((url) => [`${name} ${url}`, governmentScore(html, "Lakeside", url)]))),
    inspectPage: Object.fromEntries(Object.entries(INSPECT).map(([name, html]) => [name, inspectPage(html, "https://city.example.gov/page", "2026-11-06", null)])),
    inspectParcelUrl: inspectPage("<form></form><main>Hello</main>", "https://city.example.gov/parcel", "2026-11-06", null),
    datasetOf: ["https://data.example.gov/d/abcd-1234", "https://example.gov/d/abcd-1234"].map(datasetOf),
    schoolLinks: schoolLinks([["https://sd.example.org/", anchors([["/a", "North Elementary"], ["/b", "West Middle School"], ["/c", "East High"], ["/d", "Oak K-8"], ["/e", "Pine K-12 School"], ["/f", "Hill Academy"], ["/g", "Bus routes"], ["/h", "A High School whose name runs far past the sixty letter limit for a name"]])]]),
    localSchools: localSchools([{ name: "North Elementary", url: "https://n.example.org/" }, { name: "East High", url: "https://e.example.org/" }], [{ name: "North Elementary School", website: null, inside: true }, { name: "West High", website: "https://w.example.org/", inside: true }], true, 6),
    withoutGuessedSites: ['site:city.example.gov agenda', 'site:guess.example.com news', 'site:.gov notice', '-site:facebook.com news', 'site:www.city.example.gov/news x'].map((query) => withoutGuessedSites(query, new Set(["city.example.gov"]))),
  };
}

function allQueryStrings() {
  const set = new Set<string>(['site:.k12.wa.us "Lakeside" calendar', 'SITE:Upper.Example.COM Inurl:Upper "x"', 'before:2026-01-01 "Lakeside" news', 'foo-site:bar.example.com "Lakeside"', '-site:.gov "Lakeside" after:2026-10-01 after:2026-11-01', 'intitle:board "Lakeside" site:a.example.org site:b.example.org']);
  for (const kit of Object.values(KITS)) {
    for (const row of stage1Queries(kit, [...TOPICS], 500)) set.add(row.query);
    for (const topic of TOPICS) for (const row of stage2Queries(kit, topic, "2026-10-01", 50)) set.add(row.query);
  }
  return [...set];
}

/** What each search service is sent, for every query. */
export async function serviceRequests(db: Db) {
  const requests: Record<string, unknown[]> = {};
  const settings = { tavilySearchApiKey: "k", integrations: { serpapiKey: "k", searchapiKey: "k", brightdataKey: "k", brightdataZone: "z", exaKey: "k" } } as unknown as Settings;
  const options = resolveRunOptions({ paid: { serpapi: 9999, searchapi: 9999, brightdata: 9999, exa: 9999, tavily: 9999 } });
  const list = allQueryStrings();
  await withRunContext({ db, runId: "capture", locationId: "loc", options }, async () => {
    for (const provider of ["serpapi", "searchapi", "brightdata", "exa", "tavily"] as const) {
      requests[provider] = [];
      const transport: HttpTransport = async (request) => {
        requests[provider].push({ url: request.url, method: request.method ?? "GET", timeoutMs: request.timeoutMs, headers: request.headers, body: request.body === undefined ? null : String(request.body) });
        return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode("{}") };
      };
      for (const query of list) await search({ db, settings, transport, query, topic: null, family: "capture", stage: "stage1", provider });
      await searchQueries(db).deleteMany({});
    }
  });
  return { tavilyRequest: list.map((query) => [query, tavilyRequest(query)]), requests };
}

/** The Jev question sent for one result. */
export async function jevRequest(db: Db) {
  let sent: unknown = null;
  const transport: HttpTransport = async (request) => { sent = { url: request.url, body: String(request.body) }; return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode('{"answers":{}}') }; };
  const settings = { integrations: { typesafeKey: "k", typesafeBase: "https://api.typesafe.example", jevModel: "jev" } } as unknown as Settings;
  const options = resolveRunOptions({ classifier: "shadow", paid: { jev: 10 } });
  const verdicts = await withRunContext({ db, runId: "capture-jev", locationId: "loc", options }, async () => classify(settings, transport, { url: "https://city.example.gov/", title: "Agendas", snippet: "s", topic: "government", query: "q", place: "Lakeside" }));
  const base = await Promise.all(["https://city.example.gov/", "https://www.msn.com/a", "https://shop.example.com/"].map((url) => classify({ integrations: {} } as unknown as Settings, transport, { url, title: "", snippet: "", place: "Lakeside" })));
  return { sent, verdicts, base };
}

// --- The fixed methods, run against a made-up web ------------------------------------------------
const listing = (title: string) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${"Lakeside city record. ".repeat(30)}</p><ul><li>November 2, 2026</li><li>October 19, 2026</li><li>October 5, 2026</li></ul></main></body></html>`;
const HOME = `<html><head><title>City of Lakeside</title></head><body>Lakeside city council, mayor, agendas, minutes, departments, city hall, permits. ${anchors([["/government", "Government"], ["/police", "Police Department"], ["/parks", "Parks"], ["https://lakesidechamber.example.org/", "Chamber of Commerce"], ["https://lakeside.legistar.com/", "Meetings"], ["https://rotary.example.org/", "Lakeside Rotary"]])}</body></html>`;
const SCHOOL_HOME = `<html><head><title>Lakeside School District</title></head><body>Lakeside schools ${anchors([["/board", "School Board"], ["/calendar", "District Calendar"], ["/athletics", "Athletics"], ["https://north.example.org/", "North Elementary"], ["https://ptsa.example.org/", "Lakeside PTSA"]])}</body></html>`;
function site(url: URL): string | null {
  const host = url.hostname;
  if (url.pathname === "/rss.aspx") return host === "city.example.gov" ? '<a href="RSSFeed.aspx?ModID=1&CID=All-newsflash.xml">News</a><a href="RSSFeed.aspx?ModID=58&CID=All-calendar.xml">Calendar</a><a href="RSSFeed.aspx?ModID=65&CID=All-agendas.xml">Agendas</a><a href="RSSFeed.aspx?ModID=63&CID=All-alerts.xml">Alerts</a><a href="RSSFeed.aspx?ModID=99&CID=All-x.xml">Other</a>' : null;
  if (url.pathname === "/AgendaCenter") return host === "city.example.gov" ? "<html>AgendaCenter</html>" : null;
  if (host === "city.example.gov") return url.pathname === "/" ? HOME : url.pathname === "/government" ? `<html><body>${anchors([["/agendas", "Agendas and Minutes"], ["/permits", "Building Permits"], ["/licence", "Business License"], ["/volunteer", "Volunteer"], ["/calendar", "Calendar"], ["/news", "City News"]])}</body></html>` : listing(url.pathname.slice(1) + " Lakeside");
  if (host === "county.example.gov") return url.pathname === "/" ? `<html><head><title>Grant County</title></head><body>Grant County Lakeside ${anchors([["/sheriff", "Sheriff"], ["/assessor", "Assessor"], ["/commissioners", "County Commissioners"], ["/events", "Events"]])}</body></html>` : listing(`Grant County ${url.pathname.slice(1)}`);
  if (host === "sd.example.org") return url.pathname === "/" ? SCHOOL_HOME : listing(`Lakeside schools ${url.pathname.slice(1)}`);
  if (host === "north.example.org") return url.pathname === "/" ? `<html><head><title>North Elementary</title></head><body>Lakeside ${anchors([["/ptsa", "PTSA"], ["/calendar", "Calendar"]])}</body></html>` : listing("North Elementary Lakeside");
  if (host === "www.lakesidechamber.org") return listing("Lakeside Chamber of Commerce");
  if (host === "www.downtownlakeside.org") return listing("Downtown Lakeside business association");
  if (host === "www.visitlakeside.com") return listing("Visit Lakeside: things to do");
  if (host === "www.lakesidecommunitycouncil.org") return listing("Lakeside Community Council");
  if (host === "lakeside.primegov.com" || host === "lakesidewa.primegov.com") return "<html>Lakeside portal</html>";
  if (["lakesidechamber.example.org", "rotary.example.org", "ptsa.example.org", "chapel.example.com", "lib.example.org"].includes(host)) return listing(`Lakeside ${host}`);
  return null;
}
function osmElements() {
  const tagOf = (kind: string) => kind === "museum" ? { tourism: "museum" } : kind === "funeral_directors" ? { shop: kind } : ["government", "association", "ngo", "charity", "foundation", "newspaper"].includes(kind) ? { office: kind } : ["park", "sports_centre"].includes(kind) ? { leisure: kind } : { amenity: kind };
  const elements = OSM_KIND_LIST.flatMap((kind, index) => [0, 1, 2].map((n) => ({ lat: 47.6 + n * 0.0001, lon: -122.3, tags: { name: `${kind} ${n}`, website: `https://${kind.replace(/_/g, "")}${n % 2}.example.org/page${n}`, ...tagOf(kind) } })).concat(index % 5 ? [] : [{ lat: 47.6, lon: -122.3, tags: { name: `Lakeside PTA ${kind}`, website: `https://pta${index}.example.org/`, ...tagOf(kind) } as never }]));
  const schools = Array.from({ length: 20 }, (_, n) => ({ lat: 47.6, lon: -122.3, tags: { name: `School ${n}`, website: `https://school${n}.example.org/`, amenity: "school" } }));
  return [...elements, ...schools, { lat: 47.6, lon: -122.3, tags: { name: "Lakeside Rowing", club: "sport" } }, { lat: 47.9, lon: -122.3, tags: { name: "Far High School", amenity: "school" } }, { lat: 47.9, lon: -122.3, tags: { name: "Far Library", amenity: "library" } }, { lat: 47.9, lon: -122.3, tags: { name: "Far Chapel", shop: "funeral_directors", website: "https://chapel.example.com/" } }];
}
const FRESH = "2099-01-01T00:00:00.000Z", OLD = "2001-01-01T00:00:00.000Z";
const dataset = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ resource: { id, name, attribution: "City of Lakeside", columns_field_name: ["date", "location"], columns_datatype: ["Calendar date", "Point"], data_updated_at: FRESH, page_views: { page_views_total: 5 }, ...extra }, metadata: { domain: "data.lakeside.gov", license: null } });
function catalog(url: URL) {
  const q = url.searchParams.get("q") ?? "";
  if (url.searchParams.get("limit") === "1") return { results: url.searchParams.get("domains") === "data.lakeside.gov" ? [{}] : [] };
  if (!url.searchParams.get("domains")) return { results: [{ metadata: { domain: "data.lakeside.gov" } }, { metadata: { domain: "data.wa.gov" } }, { metadata: { domain: "data.grantcounty.gov" } }] };
  const rows = [dataset("aaaa-0001", "Police Calls for Service"), dataset("aaaa-0002", "Crime Incidents Archive"), dataset("aaaa-0003", "Fire 911 Dispatch"), dataset("aaaa-0004", "Building Permits"), dataset("aaaa-0005", "Permit totals by year"), dataset("aaaa-0006", "Food Establishment Inspections"), dataset("aaaa-0007", "New Business Licenses"), dataset("aaaa-0008", "Liquor Licence Applications"), dataset("aaaa-0009", "311 Service Requests"), dataset("aaaa-0010", "Code Enforcement Cases"), dataset("aaaa-0011", "Police Old Data", { data_updated_at: OLD }), dataset("aaaa-0012", "Police No Dates", { columns_datatype: ["Text"] }), dataset("aaaa-0013", "Police No Place", { columns_field_name: ["date"], columns_datatype: ["Calendar date"] }), dataset("aaaa-0014", "Real Property Sales"), dataset("aaaa-0015", "Deed Transfers 2019"), dataset("aaaa-0016", "Rental Licenses"), dataset("aaaa-0017", "Contractor Licenses"), dataset("aaaa-0018", "City Licenses", { columns_field_name: ["date", "city"], columns_datatype: ["Calendar date", "Text"] })];
  return { results: q ? rows : [] };
}
function fakeWeb(seen: string[]): HttpTransport {
  return async (request) => {
    const url = new URL(request.url);
    seen.push(request.method === "POST" ? `POST ${request.url} ${String(request.body)}` : request.url);
    const send = (status: number, text: string, type = "text/html") => ({ url: request.url, status, headers: { "content-type": type }, body: new TextEncoder().encode(text) });
    const json = (value: unknown) => send(200, JSON.stringify(value), "application/json");
    if (url.pathname === "/robots.txt") return send(200, "User-agent: *\nDisallow:\n", "text/plain");
    if (url.hostname === "nominatim.openstreetmap.org") return json(url.searchParams.get("county") ? [{ category: "boundary", extratags: { website: "https://county.example.gov/" } }] : url.pathname.includes("reverse") ? { address: { postcode: "98000-1234" } } : [{ extratags: { website: "https://city.example.gov/" } }]);
    if (url.hostname === "geocoding.geo.census.gov") return json({ result: { geographies: { Counties: [{ NAME: "Grant County" }], "Unified School Districts": [{ GEOID: "5300001", NAME: "Lakeside School District" }] } } });
    if (url.hostname.includes("overpass")) return json({ elements: osmElements() });
    if (url.hostname === "api.us.socrata.com") return json(catalog(url));
    if (url.hostname === "webapi.legistar.com") return url.pathname.includes("/lakesidewa/") ? json([{ BodyId: 1 }]) : send(404, "");
    if (url.hostname.endsWith(".api.civicclerk.com")) return url.hostname.startsWith("grantcountywa") ? json({ value: [] }) : send(404, "");
    // Queries run four at a time, so each gets its own pages: no result depends on which finished first.
    if (url.hostname === "api.tavily.com") { const id = createHash("sha256").update(String(request.body)).digest("hex").slice(0, 10); return json({ results: [{ url: `https://city.example.gov/agendas-${id}`, title: "Agendas Lakeside", content: "Lakeside agendas", published_date: "2026-10-01" }, { url: `https://www.msn.com/story-${id}`, title: "Lakeside story", content: "Lakeside" }] }); }
    const page = site(url);
    return page === null ? send(404, "not here") : send(200, page);
  };
}
const LOCATION = { id: "loc", name: "Lakeside, WA", state: "WA", latitude: 47.6, longitude: -122.3, systems: [], government: { website: "https://city.example.gov/" } } as unknown as LocationProfile;
const NEIGHBOURHOOD = { ...LOCATION, id: "hood", name: "Northgate, Lakeside, WA", community: { name: "Northgate", parent_name: "Lakeside", coverage_terms: [], latitude: 47.6, longitude: -122.3 } } as unknown as LocationProfile;

const sorted = (rows: unknown[]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["at", "checked_at"].includes(key)).map(([key, item]) => [key, clean(item)]));
  return value;
}

async function seed(db: Db) {
  await db.collection("census_places").deleteMany({});
  await db.collection("census_places").insertOne({ name: "Lakeside", state: "WA", latitude: 47.6, longitude: -122.3, name_lower: "lakeside" });
  await db.collection("school_districts").updateOne({ _id: "5300001" as never }, { $set: { name: "Lakeside School District", website: "https://sd.example.org/" } }, { upsert: true });
  await db.collection("news_publishers").insertMany([{ location_id: "loc", url: "https://valley.example.com/", host: "valley.example.com", name: "Valley News", hits: 5 }, { location_id: "loc", url: "https://www.msn.com/x", host: "msn.com", name: "MSN", hits: 9 }, { location_id: "loc", url: "https://once.example.com/", host: "once.example.com", name: "Once", hits: 1 }]);
}

// The budget row is created by the first paid call, and calls racing to create it can be refused: each run below opens it first.
/** Every fixed method, with what each asked for and returned. */
export async function methodRuns(db: Db) {
  await seed(db);
  const out: Record<string, unknown> = {};
  const settings = { tavilySearchApiKey: "k", llmDiscovery: true, modelDailyCalls: 100, modelProviders: [], lightModel: "light", integrations: {} } as unknown as Settings;
  const options = resolveRunOptions({ flow: "agentic", search_provider: "tavily", paid: { tavily: 9999 } });
  const log = { info() {}, warn() {}, error() {} };
  for (const location of [LOCATION, NEIGHBOURHOOD]) {
    for (const method of ["government", "institutions", "meetings", "opendata", "schools", "groups", "publishers", "homesales"]) {
      const seen: string[] = [];
      const transport = fakeWeb(seen);
      const model = new FakeModel(() => ({ sources: [{ name: "Lakeside Rotary", url: "https://rotary.example.org/", section: "community", located_inside: true, why: "Local" }, { name: "Odd", url: "https://chapel.example.com/", section: "obituaries", located_inside: false, why: "x" }, { name: "Bad", url: "https://lib.example.org/", section: "nope", located_inside: true, why: "y" }, { name: "Skip", url: "https://www.msn.com/x", section: "news", located_inside: true, why: "z" }] }));
      const context = { db, settings, transport, fetcher: new Fetcher(transport, undefined, false), location, today: "2026-11-06", log, model } as unknown as DiscoveryContext;
      await db.collection("discovered_sources").deleteMany({});
      await db.collection("search_queries").deleteMany({});
      const result = await withRunContext({ db, runId: `capture-${method}`, locationId: location.id, options }, async () => { await paidRefusal("tavily"); return methodDefinition(method)!.run(context); }).catch((error: unknown) => ({ candidates: [], detail: `threw: ${String(error)}` }));
      out[`${location.id}:${method}`] = clean({ result: { ...result, candidates: sorted(result.candidates) }, seen: sorted([...new Set(seen)].filter((url) => !url.endsWith("/robots.txt"))), prompts: model.calls.map((call) => call.prompt) });
    }
  }
  return out;
}

/**
 * The mapping agent's rounds against the made-up web, with a scripted model: round 1's anchors,
 * round 2's angles (one refused as not local, one Tavily exploration), triage, the model check's
 * verdicts, and the prompts it was sent apart from the skill. It ends on three unusable plans in a
 * row. With no model, it stops at once.
 */
export async function agentRuns(db: Db) {
  await seed(db);
  const out: Record<string, unknown> = {};
  const settings = { tavilySearchApiKey: "k", modelDailyCalls: 100, modelProviders: [], integrations: {} } as unknown as Settings;
  const options = resolveRunOptions({ flow: "agentic", search_provider: "tavily", paid: { tavily: 9999 }, topics: ["crime", "government", "news"] });
  const log = { info() {}, warn() {}, error() {} };
  const plans = [
    { categories: [{ category: "crime", searches: [{ tool: "tavily" }] }, { category: "government", searches: [{ tool: "tavily" }] }, { category: "news", searches: [{ tool: "tavily" }] }] },
    { categories: [
      { category: "crime", angle: "institutions", angle_reason: "the north precinct covers Northgate", searches: [{ tool: "tavily", query: "Where does the Northgate police precinct post its news?" }] },
      { category: "government", angle: "tool_native", angle_reason: "the city site is the hub", searches: [{ tool: "tavily", url: "https://city.example.gov/", instruction: "find the council agendas" }] },
      { category: "news", angle: "geography", angle_reason: "the wider region", searches: [{ tool: "tavily", query: "Washington news" }] },
    ] },
  ];
  for (const [name, planner] of [["model", true], ["rules", false]] as const) {
    const seen: string[] = [];
    const transport = fakeWeb(seen);
    let call = 0;
    const model = new FakeModel((request) => {
      if (/one verdict per source id/.test(request.prompt)) return { verdicts: request.prompt.split("\n\nSource id: ").slice(1).map((block) => ({ id: block.split("\n")[0], verdict: /agendas/.test(block) ? "accept" : "reject", reason_code: /agendas/.test(block) ? "A1" : "R3", evidence: "x", reason: "y" })) };
      if (/You are triaging search results/.test(request.prompt)) return { decisions: [...request.prompt.matchAll(/^\[(r\d+-\d+)\] (\S+)/gm)].map(([, id, url]) => /agendas/.test(url) ? { id, action: "propose", category: "government" } : { id, action: "skip", why: "a national outlet, not local" }) };
      return plans[call++] ?? { wander: true };
    });
    const context = { db, settings, transport, fetcher: new Fetcher(transport, undefined, false), location: NEIGHBOURHOOD, today: "2026-11-06", log, model: planner ? model : null, judgeModel: model } as unknown as DiscoveryContext;
    for (const collection of ["discovered_sources", "search_queries", "source_map", "agent_state"]) await db.collection(collection).deleteMany({});
    const runId = `agent-${name}`;
    const result = await withRunContext({ db, runId, locationId: NEIGHBOURHOOD.id, options }, async () => { await paidRefusal("tavily"); return agentJob(context, 0); });
    const skill = mappingSkill().text;
    const state = await db.collection<AgentState>("agent_state").findOne({ _id: runId });
    out[name] = clean({
      result, steps: state?.steps.map(({ ms: _ms, ...step }) => step) ?? [], sources: state?.sources ?? [], checklist: state?.checklist ?? {}, unavailable: state?.unavailable ?? {}, finished: state?.finished?.reason ?? null,
      known_hosts: state?.known_hosts ?? [], seen: sorted([...new Set(seen)].filter((url) => !url.endsWith("/robots.txt"))), prompts: model.calls.map((call) => call.prompt.split(skill).join("<SKILL>")),
    });
  }
  return out;
}

export function pureCapture() { return { queries: queries(), pure: pure() }; }
export type { PriorityTopic };
