import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { renderToStaticMarkup } from "react-dom/server";
import { internalReturnPath, internalToken, passwordMatches, validInternalToken, INTERNAL_TTL } from "../../../lib/internal-access";

const password = "test-only-password-not-a-deployment-secret";
describe("shared internal-map password", () => {
  const now = 1_800_000_000_000;
  it("fails closed when no password is configured", () => {
    expect(passwordMatches("", undefined)).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
    expect(validInternalToken(internalToken(password, now), undefined, now)).toBe(false);
  });
  it("accepts only the exact password without leaking it in a session", () => {
    expect(passwordMatches(password, password)).toBe(true);
    expect(passwordMatches(`${password} `, password)).toBe(false);
    expect(internalToken(password, now)).not.toContain(password);
    expect(internalToken(password, now)).not.toBe(internalToken(password, now));
  });
  it("signs anonymous eight-hour sessions and revokes them on password rotation", () => {
    const token = internalToken(password, now);
    expect(validInternalToken(token, password, now)).toBe(true);
    expect(validInternalToken(token, "rotated-test-password", now)).toBe(false);
    expect(validInternalToken(token, password, now + INTERNAL_TTL * 1000)).toBe(false);
    expect(validInternalToken(token, password, now - 1000)).toBe(false);
    expect(validInternalToken(`${token.slice(0, -1)}z`, password, now)).toBe(false);
    expect(validInternalToken(`${token}.extra`, password, now)).toBe(false);
  });
  it("restricts redirects to the internal map pages", () => {
    expect(internalReturnPath("https://example.test/")).toBe("/source-map");
    expect(internalReturnPath("//example.test/")).toBe("/source-map");
    expect(internalReturnPath("/source-map/../../login")).toBe("/source-map");
    expect(internalReturnPath("/source-map?location=fixture&mode=edition&run=run-id")).toBe("/source-map?location=fixture&mode=edition&run=run-id");
    expect(internalReturnPath("/interest-usage")).toBe("/interest-usage");
  });
});

const mocks = vi.hoisted(() => ({ auth: vi.fn(), allowlist: vi.fn(), headers: vi.fn(), cookies: vi.fn(), deps: vi.fn(), database: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth, isAdminEmail: mocks.allowlist, getMongoDatabase: mocks.database }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: mocks.deps }));
vi.mock("@/pipeline/storage/mongo", async (original) => ({ ...await original<object>(), getDatabase: mocks.database }));
vi.mock("@/lib/pipeline-queue", () => ({ queueNextJob: vi.fn() }));
vi.mock("@/lib/job-chain", () => ({ callNextJob: vi.fn() }));

import { internalRoute } from "../../../lib/admin-api";
import { GET as sourceMap } from "../../../app/api/maps/source-map/route";
import { GET as locations } from "../../../app/api/maps/locations/route";
import { GET as locationMap } from "../../../app/api/maps/locations/[locationId]/source-map/route";
import { GET as editionMap } from "../../../app/api/maps/locations/[locationId]/edition-map/route";
import { GET as usageMap } from "../../../app/api/maps/usage-map/route";
import { POST as unlock, DELETE as lock } from "../../../app/api/internal-access/route";
import { GET as modelUsage } from "../../../app/api/admin/model-usage/route";
import { GET as adminLocations } from "../../../app/api/admin/locations/route";
import { GET as adminSources } from "../../../app/api/admin/source-map/route";
import { GET as adminUsage } from "../../../app/api/admin/usage-map/route";
import { GET as adminEditions } from "../../../app/api/admin/locations/[locationId]/edition-map/route";
import { GET as adminLocationMap, PATCH as editSource, POST as refreshSources } from "../../../app/api/admin/locations/[locationId]/source-map/route";
import { POST as addSource } from "../../../app/api/admin/locations/[locationId]/links/route";
import { DELETE as removeLocation } from "../../../app/api/admin/locations/[locationId]/route";
import { POST as runAction } from "../../../app/api/admin/runs/[runId]/actions/route";
import { GET as photoCatalog, POST as importPhotos } from "../../../app/api/admin/locations/[locationId]/photo-catalog/route";
import SourceMapPage from "../../../app/source-map/page";
import InterestUsagePage from "../../../app/interest-usage/page";
import { GOOGLE_ANALYTICS_URL } from "../../../lib/analytics";
import MapShell from "../../../app/components/map-shell";
import InternalGate from "../../../app/components/internal-gate";

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("password_only_maps_test");
}, 60_000);
beforeEach(async () => {
  mocks.auth.mockResolvedValue(null);
  mocks.headers.mockResolvedValue(new Headers({ host: "workspace.example.test" }));
  mocks.cookies.mockResolvedValue({ get: () => undefined });
  mocks.database.mockResolvedValue(db);
  await db.dropDatabase();
  await db.collection("journalist_admins").insertOne({ email: "fixture@example.test", enabled: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

function unlocked() {
  vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
  mocks.cookies.mockResolvedValue({ get: () => ({ value: internalToken(password) }) });
}
function unlockRequest(supplied = password, extraHeaders: Record<string, string> = {}) {
  return new Request("https://workspace.example.test/api/internal-access", {
    method: "POST", headers: { origin: "https://workspace.example.test", ...extraHeaders },
    body: new URLSearchParams({ password: supplied, returnTo: "/interest-usage" }),
  });
}

it("protects every map read before database dependencies, checking only for a sign-in", async () => {
  const context = { params: Promise.resolve({ locationId: "fixture-wa" }) };
  for (const configured of ["", password]) {
    vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", configured);
    const request = new Request("https://workspace.example.test/api/maps/source-map");
    const responses = await Promise.all([sourceMap(request), locations(request), locationMap(request, context), editionMap(request, context), usageMap(request)]);
    for (const response of responses) {
      expect(response.status).toBe(configured ? 403 : 503);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    }
  }
  expect(mocks.database).not.toHaveBeenCalled();
  expect(mocks.deps).not.toHaveBeenCalled();
});

it("opens map reads to a signed-in journalist with no password cookie", async () => {
  vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
  mocks.auth.mockResolvedValue({ user: { email: "fixture@example.test" } });
  const handler = vi.fn().mockResolvedValue({ read: true });
  const response = await internalRoute(new Request("https://workspace.example.test/api/maps/source-map"), handler);
  expect(response.status).toBe(200);
  expect(handler).toHaveBeenCalledWith({ db });
  mocks.auth.mockResolvedValue({ user: { email: "stranger@example.test" } });
  expect((await internalRoute(new Request("https://workspace.example.test/api/maps/source-map"), handler)).status).toBe(403);
});

it("allows password-only reads without consulting an admin session and rejects writes", async () => {
  unlocked();
  const handler = vi.fn().mockResolvedValue({ read: true });
  const response = await internalRoute(new Request("https://workspace.example.test/api/maps/source-map"), handler);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ read: true });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(handler).toHaveBeenCalledWith({ db });
  expect(mocks.auth).not.toHaveBeenCalled();
  expect(mocks.deps).not.toHaveBeenCalled();
  handler.mockClear();
  expect((await internalRoute(new Request("https://workspace.example.test/api/maps/source-map", { method: "PATCH" }), handler)).status).toBe(405);
  expect(handler).not.toHaveBeenCalled();
});

it("renders the internal map gate without journalist sign-in and unlocks with a password cookie", async () => {
  vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
  const page = await SourceMapPage({ searchParams: Promise.resolve({}) });
  expect(page.type).toBe(MapShell);
  const gate = page.props.children.props;
  const locked = renderToStaticMarkup(await InternalGate({ ...gate, children: "protected fixture" }));
  expect(locked).toContain("Signed-in journalists open these maps directly");
  expect(locked).toContain('action="/api/internal-access"');
  expect(locked).not.toContain("protected fixture");
  unlocked();
  expect(await InternalGate({ ...gate, children: "protected fixture" })).toBe("protected fixture");
  expect(mocks.database).not.toHaveBeenCalled();
});

it("never grants admin data, source mutation or pipeline privileges to a map cookie", async () => {
  unlocked();
  const context = { params: Promise.resolve({ locationId: "fixture-wa" }) };
  const request = new Request("https://workspace.example.test/api/admin/locations", { headers: { cookie: `newsbee-internal=${internalToken(password)}` } });
  const write = new Request(request.url, { method: "POST", headers: { cookie: request.headers.get("cookie")!, origin: "https://workspace.example.test" }, body: "{}" });
  const responses = await Promise.all([
    adminLocations(request), adminSources(request), adminUsage(request), adminLocationMap(request, context), adminEditions(request, context), modelUsage(request),
    editSource(write, context), refreshSources(write, context), addSource(write, context), photoCatalog(request, context), importPhotos(write, context),
    removeLocation(new Request(write.url, { method: "DELETE", headers: write.headers }), context),
    runAction(write, { params: Promise.resolve({ runId: "fixture-run" }) }),
  ]);
  expect(responses.map((response) => response.status)).toEqual(Array(responses.length).fill(401));
  expect(mocks.deps).not.toHaveBeenCalled();
  expect(mocks.database).not.toHaveBeenCalled();
});

it("redirects the former interest and usage map route to Google Analytics", () => {
  expect(GOOGLE_ANALYTICS_URL).toBe("https://analytics.google.com/analytics/web/#/a415516569p563321884/reports/intelligenthome?params=_u..nav%3Dmaui");
  expect(() => InterestUsagePage()).toThrow(`redirect:${GOOGLE_ANALYTICS_URL}`);
  const navigation = renderToStaticMarkup(MapShell({ page: "source-map", title: "Source map", description: "Map", children: "Map" }));
  expect(navigation).toContain(`href="${GOOGLE_ANALYTICS_URL.replaceAll("&", "&amp;")}"`);
  expect(mocks.database).not.toHaveBeenCalled();
});

it("keeps admin model usage bounded and permits authenticated source editing without a map cookie", async () => {
  mocks.auth.mockResolvedValue({ user: { email: "fixture@example.test" } });
  mocks.allowlist.mockResolvedValue(true);
  mocks.deps.mockResolvedValue({ db });
  await db.collection<{ _id: string; id: string; systems: unknown[] }>("locations").insertOne({ _id: "fixture-wa", id: "fixture-wa", systems: [] });
  expect((await modelUsage(new Request("https://workspace.example.test/api/admin/model-usage?days=365"))).status).toBe(400);
  const response = await refreshSources(new Request("https://workspace.example.test/api/admin/locations/fixture-wa/source-map", {
    method: "POST", headers: { origin: "https://workspace.example.test" }, body: "{}",
  }), { params: Promise.resolve({ locationId: "fixture-wa" }) });
  expect(response.status).toBe(200);
  expect(mocks.cookies).not.toHaveBeenCalled();
});

it("defaults catalog imports to validation and requires an authenticated same-origin apply", async () => {
  mocks.auth.mockResolvedValue({ user: { email: "fixture@example.test" } });
  mocks.allowlist.mockResolvedValue(true);
  const context = { params: Promise.resolve({ locationId: "fixture-wa" }) };
  const body = { version: 1, location_id: "fixture-wa", sources: [{ id: "organizer", name: "Town Garden organizer", kind: "supplied", status: "pending",
    reviewed_on: "2026-01-01", expires_on: "2099-01-01", evidence_url: "https://organizer.example/permissions",
    permission: { editorial: false, archive: false, crop: false }, photos: [], scope: { kind: "venue", name: "Town Garden", city: "Seattle" } }] };
  const request = (query = "", origin = "https://workspace.example.test", data: unknown = body) => new Request(
    "https://workspace.example.test/api/admin/locations/fixture-wa/photo-catalog" + query,
    { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(data) });
  expect((await importPhotos(request("?apply=true", "https://untrusted.example.test"), context)).status).toBe(403);
  expect(mocks.deps).not.toHaveBeenCalled();
  mocks.deps.mockResolvedValue({ db });
  await db.collection<{ _id: string; id: string; name: string; systems: unknown[] }>("locations")
    .insertOne({ _id: "fixture-wa", id: "fixture-wa", name: "Fixture town", systems: [] });
  const validated = await importPhotos(request(), context);
  expect(validated.status).toBe(200); expect(await validated.json()).toMatchObject({ applied: false });
  expect(await db.collection("photo_catalog_sources").countDocuments()).toBe(0);
  expect((await importPhotos(request("?apply=true"), context)).status).toBe(200);
  expect(await db.collection("photo_catalog_sources").countDocuments()).toBe(1);
  const listed = await photoCatalog(new Request("https://workspace.example.test/api/admin/locations/fixture-wa/photo-catalog"), context);
  expect(listed.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await listed.json()).toMatchObject({ sources: [{ id: "organizer", status: "pending" }] });
  expect((await importPhotos(request("?apply=true", undefined, { ...body, location_id: "another-community" }), context)).status).toBe(400);
  expect((await importPhotos(request("?apply=true", undefined, "x".repeat(256 * 1024)), context)).status).toBe(400);
  expect(await db.collection("photo_catalog_sources").countDocuments()).toBe(1);
});

it("keeps deletion same-origin and owner-only, while allowing the owner to remove an idle fixture", async () => {
  mocks.auth.mockResolvedValue({ user: { email: "fixture@example.test" } });
  mocks.allowlist.mockResolvedValue(true);
  const context = { params: Promise.resolve({ locationId: "fixture-wa" }) };
  const request = (origin: string) => new Request("https://workspace.example.test/api/admin/locations/fixture-wa", { method: "DELETE", headers: { origin } });
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  expect((await removeLocation(request("https://workspace.example.test"), context)).status).toBe(403);
  expect(mocks.deps).not.toHaveBeenCalled();
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "fixture@example.test");
  expect((await removeLocation(request("https://untrusted.example.test"), context)).status).toBe(403);
  expect(mocks.deps).not.toHaveBeenCalled();
  vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "fixture-reader-root");
  vi.stubEnv("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID", "fixture-pipeline-root");
  const store = { kind: "local", list: vi.fn().mockResolvedValue([]), findFolder: vi.fn().mockResolvedValue(null),
    removeFile: vi.fn(), saveJson: vi.fn().mockResolvedValue("fixture-directory") };
  mocks.deps.mockResolvedValue({ db, store });
  await db.collection<{ _id: string; id: string; name: string; systems: unknown[] }>("locations")
    .insertOne({ _id: "fixture-wa", id: "fixture-wa", name: "Fixture town", systems: [] });
  const response = await removeLocation(request("https://workspace.example.test"), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ removed: { locations: 1 }, removed_files: 0 });
  expect(store.saveJson).toHaveBeenCalledTimes(2);
  expect(store.removeFile).not.toHaveBeenCalled();
  expect(await db.collection("locations").countDocuments()).toBe(0);
});

it("unlocks anonymously, preserves the browser origin, and sets secure private cookie attributes", async () => {
  vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
  vi.stubEnv("NODE_ENV", "production");
  const response = await unlock(new Request("http://localhost:3107/api/internal-access", {
    method: "POST", headers: { origin: "http://127.0.0.1:3107", host: "127.0.0.1:3107" },
    body: new URLSearchParams({ password, returnTo: "/interest-usage" }),
  }));
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("http://127.0.0.1:3107/interest-usage");
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/Secure/);
  expect(cookie).toMatch(/SameSite=strict/i);
  expect(cookie).toContain(`Max-Age=${INTERNAL_TTL}`);
  expect(cookie).not.toContain(password);
  expect(validInternalToken(/newsbee-internal=([^;]+)/.exec(cookie)?.[1], password)).toBe(true);
  expect(mocks.auth).not.toHaveBeenCalled();
  expect(mocks.deps).not.toHaveBeenCalled();
  const locked = await lock(new Request("https://workspace.example.test/api/internal-access", { method: "DELETE", headers: { origin: "https://workspace.example.test" } }));
  expect(locked.status).toBe(200);
  expect(locked.headers.get("set-cookie")).toContain("Max-Age=0");
});

it("fails closed on unlock without configuration and rejects cross-origin unlock and lock", async () => {
  vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", "");
  expect((await unlock(unlockRequest())).status).toBe(503);
  vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
  expect((await unlock(unlockRequest(password, { origin: "https://other.example.test" }))).status).toBe(403);
  expect((await lock(new Request("https://workspace.example.test/api/internal-access", { method: "DELETE" }))).status).toBe(403);
  expect(mocks.database).not.toHaveBeenCalled();
});

it("durably throttles anonymous attempts even after cookie deletion or spoofed forwarding headers", async () => {
  vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
  vi.stubEnv("VERCEL", "");
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  for (let attempt = 1; attempt <= 11; attempt++) {
    const response = await unlock(unlockRequest(attempt > 10 ? password : "wrong", { "x-forwarded-for": `192.0.2.${attempt}`, "x-vercel-forwarded-for": `192.0.2.${attempt}` }));
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBe(`https://workspace.example.test/interest-usage?unlock=${attempt > 10 ? "limited" : "password"}`);
    if (attempt > 10) expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  }
  expect(await db.collection("internal_access_attempts").countDocuments()).toBe(1);
});

it("uses separate hashed Vercel platform-address buckets without storing raw addresses", async () => {
  vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
  vi.stubEnv("VERCEL", "1");
  for (const ip of ["192.0.2.1", "192.0.2.2"]) await unlock(unlockRequest("wrong", { "x-vercel-forwarded-for": ip }));
  const buckets = await db.collection("internal_access_attempts").find({}).toArray();
  expect(buckets).toHaveLength(2);
  expect(JSON.stringify(buckets)).not.toContain("192.0.2.");
});

it("serves real map reads with no admin, hides connector/private data, and does not persist live edition reviews", async () => {
  unlocked();
  const docs = (collection: string) => db.collection<{ _id: string } & Record<string, unknown>>(collection);
  await docs("locations").insertOne({ _id: "fixture-wa", id: "fixture-wa", name: "Fixture, WA", latitude: 47, longitude: -122, private_config: "private-config-marker" });
  await docs("source_map").insertOne({ _id: "fixture-source", source_id: "fixture-source", location_id: "fixture-wa", reader: "web", section: "news", name: "Fixture source", status: "active", found_by: { method: "editor", detail: "Fixture" }, params: { token: "private-config-marker" }, health: {} });
  await docs("pipeline_runs").insertOne({ _id: "fixture-run", location_id: "fixture-wa", location_name: "Fixture, WA", status: "collecting", today: "2027-01-15", window: ["2027-01-01", "2027-01-15"], sources: [], created_at: 1 });
  await db.collection("reader_engagement").insertOne({ location_id: "fixture-wa", action: "view", at: new Date() });
  const context = { params: Promise.resolve({ locationId: "fixture-wa" }) };
  const request = new Request("https://workspace.example.test/api/maps/source-map");
  const responses = await Promise.all([sourceMap(request), locations(request), locationMap(request, context), editionMap(request, context), usageMap(request)]);
  const data = await Promise.all(responses.map((response) => response.json()));
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(data[0].sources).toHaveLength(1);
  expect(data[1]).toEqual({ locations: [{ id: "fixture-wa", name: "Fixture, WA" }] });
  expect(data[2].sources).toHaveLength(1);
  expect(data[3].map.run_id).toBe("fixture-run");
  expect(data[4].totals.reads).toBe(1);
  expect(JSON.stringify(data)).not.toContain("private-config-marker");
  expect(await db.collection("edition_maps").countDocuments()).toBe(0);
  expect(mocks.auth).not.toHaveBeenCalled();
  expect(mocks.deps).not.toHaveBeenCalled();
});

it("does not fall back to another location's run when selecting an edition map", async () => {
  unlocked();
  const findOne = vi.fn().mockResolvedValue(null);
  mocks.database.mockResolvedValue({ collection: () => ({ findOne }) });
  const response = await editionMap(new Request("https://workspace.example.test/api/maps/locations/town-wa/edition-map?run=other-town-run"), { params: Promise.resolve({ locationId: "town-wa" }) });
  expect(response.status).toBe(404);
  expect(findOne).toHaveBeenCalledWith({ _id: "other-town-run", location_id: "town-wa" }, expect.anything());
});
