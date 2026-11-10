import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveCredentialProfile, safeProfile, saveCredentialProfile } from "../../accounts/credentials";
import { infrastructureSettings, personalSettings } from "../../accounts/execution";
import { Fetcher } from "../../connectors/fetcher";
import { propertyConnector } from "../../connectors/property";
import type { ConnectorContext, LocationProfile } from "../../connectors/types";
import { lightSettings, loadSettings, type Settings } from "../../core/config";
import type { HttpRequest, HttpTransport } from "../../core/http";
import { resolveRunOptions, withRunContext } from "../../core/run-options";
import { openPage } from "../../discovery/evaluate";
import { methodDefinition, type DiscoveryContext } from "../../discovery/methods";
import { createRuntime } from "../../model/runtime";
import { search } from "../../search/provider";
import { ensureApiCallIndexes } from "../../trace/gateway";

// The made-up sites have no DNS, and nothing here needs pacing.
vi.mock("../../connectors/public-http", async (original) => ({ ...await original<object>(), publicSourceTransport: (transport: HttpTransport) => transport }));
vi.mock("../../connectors/fetch-state", async (original) => ({ ...await original<object>(), reserveHost: async () => 0 }));

const principal = { id: "fixture-editor", email: "editor@example.org", role: "editor" as const };
const LOCATION = { id: "loc", name: "Lakeside, WA", state: "WA", latitude: 47.6, longitude: -122.3, systems: [], government: null } as unknown as LocationProfile;
/** Every planned service's personal value, each different from what the environment holds. */
const PERSONAL = {
  serpapiKey: "personal-serpapi", searchapiKey: "personal-searchapi", brightdataKey: "personal-brightdata", brightdataZone: "personal-serp-zone",
  brightdataUnlockerZone: "personal-unlocker-zone", exaKey: "personal-exa", scrapingbeeKey: "personal-scrapingbee", jinaKey: "personal-jina", attomKey: "personal-attom",
  falKey: "personal-fal",
};
const ENVIRONMENT = {
  NEWSBEE_GEMINI_API_KEY: "env-gemini", NEWSBEE_SERPAPI_API_KEY: "env-serpapi", NEWSBEE_SEARCHAPI_API_KEY: "env-searchapi", NEWSBEE_BRIGHTDATA_API_KEY: "env-brightdata",
  NEWSBEE_BRIGHTDATA_ZONE: "env-serp-zone", NEWSBEE_BRIGHTDATA_UNLOCKER_ZONE: "env-unlocker-zone", NEWSBEE_EXA_API_KEY: "env-exa", NEWSBEE_TAVILY_API_KEY: "env-tavily",
  NEWSBEE_SCRAPINGBEE_API_KEY: "env-scrapingbee", NEWSBEE_JINA_API_KEY: "env-jina", NEWSBEE_ATTOM_API_KEY: "env-attom", FAL_KEY: "env-fal",
};

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("personal_keys"); }, 60_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  await ensureApiCallIndexes(db);
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify({ fixture: Buffer.alloc(32, 7).toString("base64") }));
  vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "fixture");
  for (const [name, value] of Object.entries(ENVIRONMENT)) vi.stubEnv(name, value);
  await db.collection("journalist_admins").insertOne({ email: principal.email, principalId: principal.id, enabled: true, role: principal.role });
});
afterEach(() => { vi.unstubAllEnvs(); });

/** The settings a run of this editor gets, from their saved, encrypted profile. */
async function runSettings(): Promise<Settings> {
  await saveCredentialProfile(db, principal, { source: "personal", config: {
    modelProviders: [{ name: "gemini", kind: "gemini", model: "personal-full-model", apiKey: "personal-gemini", baseUrl: "https://generativelanguage.googleapis.com" }],
    lightModel: "personal-light-model", tavilySearchApiKey: "personal-tavily", integrations: PERSONAL,
  } });
  const profile = await effectiveCredentialProfile(db, principal);
  return personalSettings(infrastructureSettings(), principal, profile);
}

/** A made-up web: every request is kept, search services answer with one result, and pages are thin, so the readers fall back. */
function web(overrides: (request: HttpRequest) => { status: number; body: string } | null = () => null) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    const answer = overrides(request);
    const respond = (status: number, body: string, type = "application/json") => ({ url: request.url, status, headers: { "content-type": type }, body: new TextEncoder().encode(body) });
    if (answer) return respond(answer.status, answer.body);
    const url = new URL(request.url);
    if (url.host === "generativelanguage.googleapis.com") return respond(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }] }));
    if (url.host === "serpapi.com" || url.host === "www.searchapi.io") return respond(200, JSON.stringify({ organic_results: [{ link: "https://lakeside.example.gov/", title: "Lakeside" }] }));
    if (url.host === "api.brightdata.com") return respond(200, JSON.stringify({ organic: [{ link: "https://lakeside.example.gov/", title: "Lakeside" }] }));
    if (url.host === "api.exa.ai") return respond(200, JSON.stringify({ results: [{ url: "https://lakeside.example.gov/", title: "Lakeside" }] }));
    if (url.host === "api.tavily.com") return respond(200, JSON.stringify({ results: [{ url: "https://lakeside.example.gov/", title: "Lakeside" }] }));
    if (url.host === "r.jina.ai") return respond(500, "");
    if (url.host === "app.scrapingbee.com") return respond(200, `<html><body><main>${"Rendered Lakeside page. ".repeat(40)}</main></body></html>`, "text/html");
    if (url.host === "api.gateway.attomdata.com") return respond(200, JSON.stringify({ property: [] }));
    if (url.pathname === "/robots.txt") return respond(200, "User-agent: *\nDisallow:\n", "text/plain");
    return respond(200, "<html><body><main>Lakeside</main></body></html>", "text/html");
  };
  return { transport, requests };
}
const PAID = { serpapi: 10, searchapi: 10, brightdata: 10, exa: 10, tavily: 10, scrapingbee: 10, brightdata_open: 10, attom: 10, gemini: 10 };
const inRun = <T,>(operation: () => Promise<T>) => withRunContext({ db, runId: "run", locationId: LOCATION.id, options: resolveRunOptions({ paid: PAID }), runKind: "map", startedAt: Date.now() / 1000 }, operation);
const discovery = (settings: Settings, transport: HttpTransport) => ({ db, settings, transport, fetcher: new Fetcher(transport, undefined, false), location: LOCATION, today: "2026-11-06", log: { info() {}, warn() {}, error() {} } }) as unknown as DiscoveryContext;
const headerOf = (request: HttpRequest | undefined, name: string) => Object.entries(request?.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

describe("Account & API settings: every planned service's personal value is used by a run", () => {
  it("never inherits deployment API credentials when a journalist has no personal profile", () => {
    const settings = personalSettings(loadSettings(), principal, null);
    expect(settings.modelProviders).toEqual([]);
    expect(settings.integrations).toMatchObject({
      serpapiKey: null, searchapiKey: null, brightdataKey: null,
      brightdataZone: null, brightdataUnlockerZone: null, exaKey: null,
      scrapingbeeKey: null, jinaKey: null, attomKey: null, falKey: null,
    });
    expect(settings.tavilySearchApiKey).toBeNull();
  });

  it("lists a field for every service, the Web Unlocker zone included, and keeps them write-only", async () => {
    const profile = safeProfile(await (async () => { await runSettings(); return effectiveCredentialProfile(db, principal); })());
    expect(profile?.config?.integrations).toMatchObject({ serpapiKey: "configured", searchapiKey: "configured", brightdataKey: "configured", brightdataZone: "configured", brightdataUnlockerZone: "configured", exaKey: "configured", scrapingbeeKey: "configured", jinaKey: "configured", attomKey: "configured", falKey: "configured" });
    expect(profile?.config?.tavilySearchApiKey).toBe("configured");
    for (const secret of [...Object.values(PERSONAL), "personal-gemini", "personal-tavily"]) expect(JSON.stringify(profile)).not.toContain(secret);
  });

  it("Gemini: the model provider's key, and the light model setting for the model check and the agent", async () => {
    const settings = await runSettings();
    const { transport, requests } = web();
    await createRuntime(lightSettings(settings), transport).generateStructured("Say ok", { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    const call = requests.find((request) => request.url.includes("generativelanguage.googleapis.com"))!;
    expect(call.url).toContain("/models/personal-light-model:generateContent");
    expect(headerOf(call, "x-goog-api-key")).toBe("personal-gemini");
  });

  it.each([
    ["serpapi", (request: HttpRequest) => new URL(request.url).searchParams.get("api_key"), "personal-serpapi"],
    ["searchapi", (request: HttpRequest) => headerOf(request, "Authorization"), "Bearer personal-searchapi"],
    ["exa", (request: HttpRequest) => headerOf(request, "x-api-key"), "personal-exa"],
    ["tavily", (request: HttpRequest) => headerOf(request, "Authorization"), "Bearer personal-tavily"],
  ] as const)("%s: its personal key", async (provider, sent, expected) => {
    const settings = await runSettings();
    const { transport, requests } = web();
    const result = await inRun(() => search({ db, settings, transport, query: `"Lakeside" council agenda ${provider}`, topic: "government", family: "agent:dork", stage: "stage1", origin: "agent", provider }));
    expect(result).toMatchObject({ skipped: null, error: null });
    expect(requests).toHaveLength(1);
    expect(sent(requests[0])).toBe(expected);
  });

  it("Bright Data dorking: its personal key and SERP zone", async () => {
    const settings = await runSettings();
    const { transport, requests } = web();
    expect(await inRun(() => search({ db, settings, transport, query: '"Lakeside" council agenda', topic: "government", family: "agent:dork", stage: "stage1", origin: "agent", provider: "brightdata" }))).toMatchObject({ skipped: null, error: null });
    expect(headerOf(requests[0], "Authorization")).toBe("Bearer personal-brightdata");
    expect(JSON.parse(String(requests[0].body)).zone).toBe("personal-serp-zone");
  });

  it("Jina and ScrapingBee: their personal keys, when a page is too thin for our fetcher", async () => {
    const settings = await runSettings();
    const { transport, requests } = web();
    const page = await inRun(() => openPage(discovery(settings, transport), new Fetcher(transport, undefined, false), "https://lakeside.example.gov/calendar", "government"));
    expect(headerOf(requests.find((request) => request.url.startsWith("https://r.jina.ai/")), "Authorization")).toBe("Bearer personal-jina");
    expect(headerOf(requests.find((request) => request.url.startsWith("https://app.scrapingbee.com/")), "Authorization")).toBe("Bearer personal-scrapingbee");
    expect(page.reader).toBe("scrapingbee");
  });

  it("Bright Data opening: its personal key and the Web Unlocker zone, not the SERP zone", async () => {
    const settings = await runSettings();
    const { transport, requests } = web((request) => request.url === "https://api.brightdata.com/request" ? { status: 200, body: `<html><body><main>${"Rendered by Bright Data. ".repeat(40)}</main></body></html>` } : null);
    // The agent's own steps never use ScrapingBee, so its paid fallback is Bright Data.
    const page = await inRun(() => openPage(discovery(settings, transport), new Fetcher(transport, undefined, false), "https://lakeside.example.gov/calendar", "agent"));
    const call = requests.find((request) => request.url === "https://api.brightdata.com/request")!;
    expect(headerOf(call, "Authorization")).toBe("Bearer personal-brightdata");
    expect(JSON.parse(String(call.body)).zone).toBe("personal-unlocker-zone");
    expect(page.reader).toBe("brightdata");
  });

  it("ATTOM: the home sales reader is offered with the personal key, and reads with it", async () => {
    const settings = await runSettings();
    const { transport, requests } = web();
    // The fixed reader only proposes ATTOM when the run's settings hold a key.
    expect((await methodDefinition("homesales")!.run(discovery({ ...settings, integrations: { ...settings.integrations, attomKey: null } }, transport))).detail).toBe("No ATTOM key set");
    const task = { type: "property" as const, source_id: "property:attom:98001", name: "ATTOM sales for 98001", params: { backend: "attom", postal_code: "98001" } };
    await inRun(() => propertyConnector.collect(task, { ...discovery(settings, transport), window: ["2026-10-01", "2026-11-06"], range: {}, linkCache: { get: async () => null, put: async () => undefined, invalidate: async () => undefined } } as unknown as ConnectorContext));
    expect(headerOf(requests.find((request) => request.url.startsWith("https://api.gateway.attomdata.com/")), "APIKey")).toBe("personal-attom");
  });

  it("leaves newly added keys unconfigured in old personal profiles instead of inheriting environment keys", async () => {
    await saveCredentialProfile(db, principal, { source: "personal", config: { integrations: { brightdataKey: "personal-brightdata" } } });
    const stored = await effectiveCredentialProfile(db, principal);
    delete (stored!.config!.integrations as Partial<typeof stored.config.integrations>).brightdataUnlockerZone;
    const settings = personalSettings(infrastructureSettings(), principal, stored);
    expect(settings.integrations.brightdataUnlockerZone).toBeNull();
    expect(settings.integrations.serpapiKey).toBeNull();
  });
});
