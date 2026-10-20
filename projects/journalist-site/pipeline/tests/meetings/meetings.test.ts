import { describe, expect, it } from "vitest";
import { loadSettings } from "../../core/config";
import { logger } from "../../core/log";
import { Fetcher } from "../../connectors/fetcher";
import { meetingsConnector, discoverGovernment, overrides, sourceId } from "../../connectors/meetings";
import * as civicclerk from "../../connectors/meetings/civicclerk";
import * as legistar from "../../connectors/meetings/legistar";
import * as meetingFacts from "../../connectors/meetings/meetings";
import { MongoLinkCache } from "../../storage/link-cache";
import { Story } from "../../editions/stories";
import { rank } from "../../ranking/meetings";
import { FakeModel } from "../support/fake-model";
import { addDays } from "../../connectors/common";
import { fixture, ReplayTransport } from "../support/replay";
import { withMongo } from "../support/mongo";
import type { ConnectorContext, GovernmentSource, LocationProfile } from "../../connectors/types";

const mongo = withMongo();
const WEBSITE = "https://www.exampletown.gov/";
const LEGISTAR = "exampletown";
const CIVIC = "exampleville";
const WINDOW: [string, string] = ["2026-11-01", "2026-11-07"];
const TODAY = "2026-10-30";
const TOWN = "Exampletown, WA";

function profile(government?: GovernmentSource | null): LocationProfile {
  return { id: "exampletown-wa", name: TOWN, state: "WA", latitude: 47.6, longitude: -122.3, systems: [{ fscskey: "WA0001", name: "Exampletown Library", latitude: 47.6, longitude: -122.3, branches: [] }], government };
}
function wiki(replay: ReplayTransport, website: string | null = WEBSITE, label = "Exampletown") {
  replay.on((request) => request.url.includes("wikidata.org/w/api.php"), (request) => {
    const action = new URL(request.url).searchParams.get("action");
    return action === "wbsearchentities"
      ? { body: { search: [{ id: "Q1", label }] } }
      : { body: { entities: { Q1: { claims: {
        P17: [{ mainsnak: { datavalue: { value: { id: "Q30" } } } }],
        P625: [{ mainsnak: { datavalue: { value: { latitude: 47.6, longitude: -122.3 } } } }],
        ...(website ? { P856: [{ mainsnak: { datavalue: { value: website } } }] } : {}),
      } } } } };
  });
}
function gov(platform = "legistar", tenant = LEGISTAR): GovernmentSource {
  return { status: "detected", platform, tenant, website: WEBSITE, wikidata_id: "Q1", pages_checked: [WEBSITE], detail: "fixture" };
}
function context(replay: ReplayTransport, government = gov()): ConnectorContext {
  return {
    location: profile(government), today: TODAY, window: WINDOW, transport: replay.transport,
    fetcher: new Fetcher(replay.transport), settings: loadSettings(),
    db: mongo.db, linkCache: new MongoLinkCache(mongo.db), log: logger("test"),
  };
}
function legistarRoutes(replay: ReplayTransport, tenant = LEGISTAR) {
  replay.on(legistar.eventsUrl(tenant, "2026-10-23", "2026-11-07"), { file: "meetings/legistar-events.json" });
  replay.on(legistar.itemsUrl(tenant, 1), { file: "meetings/legistar-upcoming-items.json" });
  replay.on(legistar.itemsUrl(tenant, 3), { file: "meetings/legistar-past-items.json" });
  replay.on(legistar.itemsUrl(tenant, 5), { body: [{ EventItemTitle: "Discussion of trail signs", EventItemMatterType: "Discussion" }] });
}
function civicRoutes(replay: ReplayTransport, tenant = CIVIC) {
  replay.on(civicclerk.eventsUrl(tenant, WINDOW[0], "2026-11-08"), { file: "meetings/civicclerk-events.json" });
  replay.on(civicclerk.agendaUrl(tenant, 11), { file: "meetings/civicclerk-agenda.json" });
}

const procedural = [
  "CALL TO ORDER", "Roll Call", "Approval of the Agenda", "Approve minutes of the October 6 meeting",
  "September 28, 2026 Retirement Board Meeting Minutes - C/T", "September 10th Minutes",
  "PUBLIC FORUM - Verbal Comments", "Public Comment", "Old Business", "Staff Reports",
  "Treasurer's Report", "Commissioner Items", "Vote Anticipated", "Adjournment",
  "Requests for reasonable accommodation: call the clerk",
  "Jane Doe (tenant); Acme LLC (landlord) Security Deposit Case Re: 4 Elm Street",
  "Kadeem Noel, Class B $4,158.38; Effective Date of Benefit: 09/01/26", "• ",
];

describe("public meeting facts", () => {
  it.each(procedural)("drops procedural/private item %s", (title) => expect(meetingFacts.itemTitle(title)).toBeNull());
  it.each([
    ["An ordinance banning glue traps.", "An ordinance banning glue traps"],
    ["• Adopt the 2027 school calendar", "Adopt the 2027 school calendar"],
    ["Update on playgrounds (15 minutes)", "Update on playgrounds (15 minutes)"],
    ["ZP-26-432; 28 Janet Circle. Conditional use", "ZP-26-432; 28 Janet Circle. Conditional use"],
  ])("keeps substantive items", (input, expected) => expect(meetingFacts.itemTitle(input)).toBe(expected));
  it("names the body's role, normalizes meeting titles, and prefers weight on dedupe", () => {
    expect(meetingFacts.context("City Council", "Exampletown")).toContain("sets local laws");
    expect(meetingFacts.context("Council on Aging", "Exampletown")).toContain("public body of Exampletown");
    expect(meetingFacts.context("Planning Commission", "Exampletown")).toContain("reviews land-use");
    expect(meetingFacts.bodyName("Board of Education Regular Meeting")).toBe("Board of Education");
    expect(meetingFacts.bodyName("City Council - Special Meeting")).toBe("City Council");
    expect(meetingFacts.bodyName("Meeting")).toBe("Meeting");
    const selected = meetingFacts.select([
      { title: "Consent item", consent: true, weight: 3 }, { title: "Same ordinance", weight: 3, outcome: "Held and Closed" },
      { title: "Discussion", weight: 0 }, { title: "same ordinance", weight: 4, outcome: "Adopted" },
    ]);
    expect(selected.map((item) => [item.title, item.outcome])).toEqual([["same ordinance", "Adopted"], ["Discussion", undefined], ["Consent item", undefined]]);
  });
  it("caps preview items and marks draft agendas", () => {
    const meeting = { source_event_id: "1", body: "City Council", start: { year: 2026, month: 11, day: 3 }, venue: null, source_url: "https://example.gov/m/1", items: Array.from({ length: 7 }, (_, n) => ({ title: `Item ${n}` })), draft_agenda: true };
    const facts = meetingFacts.preview(meeting, "Exampletown")!;
    expect(facts.title).toBe("City Council agenda: Item 0");
    expect(facts.description).toContain("Item 4");
    expect(facts.description).not.toContain("Item 5");
    expect(facts.description).toContain("The full agenda lists 2 more items.");
    expect(facts.description).toContain("draft and may change");
    expect([facts.venue, facts.event_date, facts.kind]).toEqual([meetingFacts.NO_VENUE, "2026-11-03", "meeting_preview"]);
    expect(meetingFacts.preview({ ...meeting, items: [] }, "X")).toBeNull();
  });
});

describe("Legistar and CivicClerk", () => {
  it("collects upcoming agendas and the past week's recorded outcomes", async () => {
    const replay = new ReplayTransport(); legistarRoutes(replay);
    const task = meetingsConnector.sources(profile(gov()), loadSettings())[0];
    const { result, events } = await meetingsConnector.collect(task, context(replay));
    const [preview, outcome] = events;
    expect(preview.title).toBe("City Council agenda: An ordinance banning glue traps");
    expect(preview.description).toContain("Resolution approving the playground contract");
    expect([preview.event_date, preview.schedule_text]).toEqual(["2026-11-03", "Tuesday, November 3, 2026, 7pm"]);
    expect(preview.venue).toBe("City Hall, 1 Main St");
    expect(outcome.kind).toBe("meeting_outcome");
    expect(outcome.title).toBe("City Council decisions: Ordinance on short-term rentals");
    expect(outcome.description).toContain("Ordinance on short-term rentals (Adopted on Second Reading)");
    expect(outcome.description).toContain("official minutes are not yet approved");
    expect(result.source_id).toBe("meetings:legistar:exampletown");
    expect([result.status, result.event_count, result.skipped_outside_window]).toEqual(["ingested", 2, 1]);
    expect(result.skipped_unusable).toEqual({ cancelled: 1, no_recorded_outcomes: 1 });
    expect(result.detail).toBe("legistar API: 1 upcoming agendas, 1 recent outcomes");
    expect(result.response_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.link_discovery).toEqual({ method: "rules" });
    expect(replay.requests.filter((request) => request.url.includes("/eventitems")).length).toBe(3);
    expect(replay.requests.some((request) => request.url.includes("/events/2/") || request.url.includes("/events/4/"))).toBe(false);
  });
  it("parses Legistar local times and CivicClerk published agendas", async () => {
    expect(legistar.start({ EventDate: "2026-11-03T00:00:00", EventTime: "7:00 PM" })).toEqual({ year: 2026, month: 11, day: 3, hour: 19, minute: 0 });
    expect(legistar.start({ EventDate: "2026-11-03T00:00:00", EventTime: null })).toEqual({ year: 2026, month: 11, day: 3 });
    const replay = new ReplayTransport(); civicRoutes(replay);
    const task = meetingsConnector.sources(profile(gov("civicclerk", CIVIC)), loadSettings())[0];
    const { result, events: [facts] } = await meetingsConnector.collect(task, context(replay, gov("civicclerk", CIVIC)));
    expect(facts.title).toBe("Board of Education agenda: Adopt the 2027 school calendar");
    expect(facts.description).toContain("Update on the new middle school (15 minutes)");
    expect(facts.schedule_text).toBe("Monday, November 2, 2026, 6pm");
    expect(facts.venue).toBe("1 School St, Exampleville");
    expect(facts.source_url).toBe("https://exampleville.portal.civicclerk.com/event/10/overview");
    expect(result.skipped_unusable).toEqual({ cancelled: 1, agenda_not_posted: 1 });
    expect(civicclerk.venue({ eventLocation: { address1: " ", city: null } })).toBeNull();
  });
  it("keeps a confirmed platform in the Mongo link cache", async () => {
    const replay = new ReplayTransport(); legistarRoutes(replay);
    const task = meetingsConnector.sources(profile(gov()), loadSettings())[0];
    await meetingsConnector.collect(task, context(replay));
    const stored = await new MongoLinkCache(mongo.db).get("exampletown-wa", task.source_id);
    expect(stored?.kind).toBe("legistar");
    expect(stored?.url).toBe(legistar.confirmUrl(LEGISTAR));
  });
  it("invalidates an empty cached endpoint, rediscovers, and retries once", async () => {
    await mongo.db.collection<{ _id: string; config_path: string; data: Record<string, unknown> }>("source_configs").updateOne({ _id: "government-sources" }, { $set: { config_path: "config/government-sources.json", data: {} } }, { upsert: true });
    const replay = new ReplayTransport(); wiki(replay);
    const task = meetingsConnector.sources(profile(gov()), loadSettings())[0];
    const ctx = context(replay);
    await ctx.linkCache.put({ source_id: task.source_id, location_id: "exampletown-wa", kind: "legistar", url: legistar.confirmUrl("stale"), page: WEBSITE, method: "rules" });
    replay.on(legistar.eventsUrl("stale", "2026-10-23", "2026-11-07"), { body: [] });
    replay.on(WEBSITE, { body: `<a href="https://${CIVIC}.portal.civicclerk.com/">Meetings</a>` });
    replay.on(civicclerk.confirmUrl(CIVIC), { body: { value: [] } });
    civicRoutes(replay);
    const { result, events } = await meetingsConnector.collect(task, ctx);
    expect(events).toHaveLength(1);
    expect(result.source_id).toBe("meetings:civicclerk:exampleville");
    expect(result.link_discovery).toEqual({ method: "rules" });
    expect(await ctx.linkCache.get("exampletown-wa", task.source_id)).toMatchObject({ kind: "civicclerk", url: civicclerk.confirmUrl(CIVIC) });
  });
  it("propagates 429/5xx but converts malformed feeds into failed outcomes", async () => {
    const task = meetingsConnector.sources(profile(gov()), loadSettings())[0];
    const rate = new ReplayTransport().on(legistar.eventsUrl(LEGISTAR, "2026-10-23", "2026-11-07"), { status: 429 });
    await expect(meetingsConnector.collect(task, context(rate))).rejects.toMatchObject({ status: 429 });
    const invalid = new ReplayTransport().on(legistar.eventsUrl(LEGISTAR, "2026-10-23", "2026-11-07"), { body: "oops" });
    const result = await meetingsConnector.collect(task, context(invalid));
    expect(result.result.status).toBe("failed");
    expect(result.result.detail).toContain("Legistar response is not JSON");
  });
  it("emits no-feed for an onboarded location without a supported platform", async () => {
    const noPlatform = { ...gov(), status: "no_platform", platform: null, tenant: null } as GovernmentSource;
    const task = meetingsConnector.sources(profile(noPlatform), loadSettings())[0];
    expect(task.source_id).toBe("meetings:none:none");
    const result = await meetingsConnector.collect(task, context(new ReplayTransport(), noPlatform));
    expect([result.result.status, result.events.length]).toEqual(["no_feed", 0]);
  });
});

describe("government platform discovery", () => {
  it("confirms linked Legistar and follows same-site agenda pages", async () => {
    const direct = new ReplayTransport(); wiki(direct);
    direct.on(WEBSITE, { body: `<a href="https://${LEGISTAR}.legistar.com/Calendar.aspx">Calendar</a>` });
    direct.on(legistar.confirmUrl(LEGISTAR), { body: [{ Id: 1 }] });
    const found = await discoverGovernment(direct.transport, profile());
    expect([found.status, found.platform, found.tenant, found.website, found.pages_checked]).toEqual(["detected", "legistar", LEGISTAR, WEBSITE, [WEBSITE]]);
    expect(sourceId(found)).toBe("meetings:legistar:exampletown");

    const pageReplay = new ReplayTransport(); wiki(pageReplay);
    const agendas = "https://www.exampletown.gov/government/agendas";
    pageReplay.on(WEBSITE, { body: '<a href="/government/agendas">Agendas</a><a href="/parks">Parks</a>' });
    pageReplay.on(agendas, { body: `<a href="https://${CIVIC}.portal.civicclerk.com/">Meetings</a>` });
    pageReplay.on(civicclerk.confirmUrl(CIVIC), { body: { value: [] } });
    const followed = await discoverGovernment(pageReplay.transport, profile());
    expect([followed.status, followed.platform, followed.tenant]).toEqual(["detected", "civicclerk", CIVIC]);
    expect(followed.pages_checked).toEqual([WEBSITE, agendas]);
    expect(pageReplay.requests.some((request) => request.url === "https://www.exampletown.gov/parks")).toBe(false);
  });
  it("guesses town tenants, reports unresolved websites, and accepts reviewed overrides", async () => {
    const replay = new ReplayTransport(); wiki(replay);
    replay.on(WEBSITE, { body: "<p>Welcome</p>" });
    replay.on(legistar.confirmUrl("exampletown"), { status: 500 });
    replay.on(civicclerk.confirmUrl("exampletown"), { body: { value: [] } });
    const guessed = await discoverGovernment(replay.transport, profile());
    expect([guessed.status, guessed.platform, guessed.tenant]).toEqual(["detected", "civicclerk", "exampletown"]);
    expect(guessed.detail).toContain("found under a name guessed from the town");
    const unresolvedReplay = new ReplayTransport(); wiki(unresolvedReplay, null, "Elsewhere");
    unresolvedReplay.on(legistar.confirmUrl("exampletownwa"), { status: 404 });
    unresolvedReplay.on(civicclerk.confirmUrl("exampletownwa"), { status: 404 });
    const unresolved = await discoverGovernment(unresolvedReplay.transport, profile());
    expect(unresolved.status).toBe("unresolved_website");
    expect(unresolved.detail).toContain("no supported meeting platform under a name guessed from the town");
    const override = await discoverGovernment(new ReplayTransport().transport, profile(), { platform: "legistar", tenant: "reviewed" });
    expect([override.status, override.tenant]).toEqual(["override", "reviewed"]);
  });
  it("prefers an AI-confirmed platform only when its upcoming-meeting probe finds more", async () => {
    const replay = new ReplayTransport(); wiki(replay);
    const agendas = "https://www.exampletown.gov/government/agendas";
    replay.on(WEBSITE, { body: `<a href="https://${LEGISTAR}.legistar.com/Calendar.aspx">Calendar</a><a href="/government/agendas">Agendas</a>` });
    replay.on(agendas, { body: `<a href="https://${CIVIC}.portal.civicclerk.com/">Meetings</a>` });
    replay.on(legistar.confirmUrl(LEGISTAR), { body: [{ Id: 1 }] });
    replay.on(civicclerk.confirmUrl(CIVIC), { body: { value: [] } });
    const first = addDays(new Date().toISOString().slice(0, 10), 1);
    const last = addDays(new Date().toISOString().slice(0, 10), 7);
    replay.on(legistar.eventsUrl(LEGISTAR, first, last), { body: [{ EventId: 1 }] });
    replay.on(civicclerk.eventsUrl(CIVIC, first, addDays(last, 1)), { body: { value: [{ id: 1 }, { id: 2 }] } });
    const model = new FakeModel(() => ({ urls: [agendas] }));
    const found = await discoverGovernment(replay.transport, profile(), null, { model });
    expect([found.status, found.platform, found.tenant]).toEqual(["detected", "civicclerk", CIVIC]);
    expect(found.detail).toContain("AI-assisted");
  });
  it("records PrimeGov robots blocks and website HTTP errors instead of raising", async () => {
    const prime = new ReplayTransport(); wiki(prime);
    prime.on(WEBSITE, { body: '<a href="https://exampletown.primegov.com/public/portal">Portal</a>' });
    prime.on("https://exampletown.primegov.com/robots.txt", { body: "User-agent: *\nDisallow: /" });
    const blocked = await discoverGovernment(prime.transport, profile());
    expect([blocked.status, blocked.platform]).toEqual(["blocked", "primegov"]);

    const down = new ReplayTransport(); wiki(down);
    down.on(WEBSITE, { status: 503 });
    const failed = await discoverGovernment(down.transport, profile());
    expect(failed.status).toBe("failed");
    expect(failed.detail).toContain("503");
  });
  it("does not invent AI URLs and confirms AI-selected pages through platform rules", async () => {
    const replay = new ReplayTransport(); wiki(replay);
    const agendas = "https://www.exampletown.gov/government/agendas";
    replay.on(WEBSITE, { body: '<a href="/government/agendas">Agendas</a>' });
    replay.on(agendas, { body: `<a href="https://${CIVIC}.portal.civicclerk.com/">Meetings</a>` });
    replay.on(civicclerk.confirmUrl(CIVIC), { body: { value: [] } });
    const model = new FakeModel(({ prompt }) => {
      expect(prompt).toContain(agendas);
      return { urls: [agendas, "https://invented.invalid/meetings"] };
    });
    const found = await discoverGovernment(replay.transport, profile(), null, { model });
    expect([found.status, found.platform, found.tenant]).toEqual(["detected", "civicclerk", CIVIC]);
    expect(replay.requests.some((request) => request.url.includes("invented.invalid"))).toBe(false);
    expect(model.calls.length).toBeGreaterThan(0);
  });
});

describe("government-source overrides and ranker", () => {
  it("loads validated overrides and orders council, date, agenda size, then title", async () => {
    await mongo.db.collection<{ _id: string; config_path: string; data: Record<string, unknown> }>("source_configs").updateOne({ _id: "government-sources" }, { $set: { config_path: "config/government-sources.json", data: { "exampletown-wa": { platform: "civicclerk", tenant: "exampleville" } } } }, { upsert: true });
    expect(await overrides("C:\\path-that-does-not-exist", mongo.db)).toEqual({ "exampletown-wa": { platform: "civicclerk", tenant: "exampleville" } });
    const stories = [
      new Story("1", "Parks", null, "meeting_preview", { body: "Parks Board", agenda_items: 9 } as never),
      new Story("2", "City Council later", null, "meeting_preview", { body: "City Council", agenda_items: 1 } as never),
      new Story("3", "City Council Budget", null, "meeting_preview", { body: "City Council", agenda_items: 2 } as never),
      new Story("4", "City Council Levy", null, "meeting_preview", { body: "City Council", agenda_items: 6 } as never),
    ];
    stories.forEach((story, index) => { story.occurrences.push({ source_id: "meetings:legistar:x", source_event_id: String(index), event_date: index === 1 ? "2026-11-05" : "2026-11-03", schedule_text: "", venue: "", room: null, source_url: "" }); });
    expect(rank(stories).map((story) => story.title)).toEqual(["City Council Levy", "City Council Budget", "City Council later", "Parks"]);
  });
});
