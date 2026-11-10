import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";

const mocks = vi.hoisted(() => ({ database: vi.fn(), guard: vi.fn(), admin: vi.fn() }));
vi.mock("@/pipeline/storage/mongo", async original => ({ ...await original<object>(), getDatabase: mocks.database }));
vi.mock("@/lib/admin-session", () => ({ adminGuard: mocks.guard, currentAdmin: mocks.admin,
  sameOrigin: (request: Request) => request.headers.get("origin") === new URL(request.url).origin }));
import { GET as getAdmin, POST as postAdmin } from "../../../app/api/admin/locations/[locationId]/photo-supply/route";
import { GET as getPublic, POST as postPublic } from "../../../app/api/photo-supply/[token]/route";
import { createPhotoInvite } from "../../images/supply";
import { PHOTO_CATALOG_SOURCES } from "../../../../../shared/photo-catalog";
import { COLLECTIONS } from "../../storage/mongo";

let server: MongoMemoryServer, client: MongoClient, db: Db;
const locationId = "supply-town", adminContext = { params: Promise.resolve({ locationId }) }, origin = "https://journalist.example";
const request = (path: string, body?: unknown) => new Request(origin + path, { method: body === undefined ? "GET" : "POST",
  headers: { origin, "Content-Type": "application/json" }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("photo-supply-routes"); });
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase(); vi.clearAllMocks();
  mocks.database.mockResolvedValue(db); mocks.guard.mockResolvedValue(null); mocks.admin.mockResolvedValue("admin@example.test");
  await db.collection<{ _id: string; id: string; name: string; systems: unknown[] }>(COLLECTIONS.locations).insertOne({ _id: locationId, id: locationId, name: "Supply Town", systems: [] });
});
const create = () => createPhotoInvite(db, locationId, "Supply Town", { source: { id: "show", name: "Community Show", evidence_url: "https://organizer.example/show",
  scope: { kind: "event", name: "Community Show", city: "Supply Town", aliases: [], source_urls: ["https://organizer.example/show"], event_date: new Date().toISOString().slice(0, 10) } } }, "admin@example.test");

it("requires an administrator for every inbox and approval action before opening the database", async () => {
  mocks.guard.mockImplementation(async () => Response.json({ detail: "Sign in" }, { status: 401 }));
  expect((await getAdmin(request("/api/admin/locations/supply-town/photo-supply"), adminContext)).status).toBe(401);
  expect((await postAdmin(request("/api/admin/locations/supply-town/photo-supply", { action: "approve", id: randomUUID() }), adminContext)).status).toBe(401);
  expect(mocks.database).not.toHaveBeenCalled();
});
it("protects public writes from cross-origin requests and hides unavailable tokens", async () => {
  const response = await postPublic(new Request(origin + "/api/photo-supply/" + "a".repeat(64), { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }),
    { params: Promise.resolve({ token: "a".repeat(64) }) });
  expect(response.status).toBe(403); expect(mocks.database).not.toHaveBeenCalled();
  const invalid = await getPublic(request("/api/photo-supply/bad"), { params: Promise.resolve({ token: "bad" }) });
  expect(invalid.status).toBe(404); expect(invalid.headers.get("Cache-Control")).toBe("private, no-store");
  expect(invalid.headers.get("Referrer-Policy")).toBe("no-referrer");
});
it("accepts a bounded permission submission without publishing or granting admin access", async () => {
  const invite = await create(), context = { params: Promise.resolve({ token: invite.token }) }, path = `/api/photo-supply/${invite.token}`;
  const publicResponse = await getPublic(request(path), context);
  const publicData = await publicResponse.json();
  expect(publicData).toHaveProperty("scope.name", "Community Show"); expect(JSON.stringify(publicData)).not.toContain("admin@example.test");
  const response = await postPublic(request(path, { request_id: randomUUID(), name: "Organizer", email: "owner@organizer.example",
    authority: true, no_charge: true, people_permissions: true, editorial: true, archive: true, crop: true,
    photos: [{ image: "https://organizer.example/photo.jpg", image_source_url: "https://organizer.example/show", image_date: new Date().toISOString().slice(0, 10), image_credit: "Pat", image_caption: "The community show." }] }), context);
  expect(response.status).toBe(200); expect(await response.json()).toHaveProperty("status", "pending");
  expect(await db.collection(PHOTO_CATALOG_SOURCES).countDocuments()).toBe(0);
  expect(mocks.guard).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
});
it("rejects oversized streamed and malformed requests without leaking database details", async () => {
  const invite = await create(), context = { params: Promise.resolve({ token: invite.token }) }, path = `/api/photo-supply/${invite.token}`;
  expect((await postPublic(request(path, "x".repeat(64 * 1024 + 1)), context)).status).toBe(400);
  expect((await postPublic(request(path, "{"), context)).status).toBe(400);
  mocks.database.mockRejectedValueOnce(Error("private database connection information"));
  const failure = await getPublic(request(path), context);
  expect(failure.status).toBe(500); expect(await failure.text()).not.toContain("private database");
});
it("creates invitations with the authenticated editor identity and private response caching", async () => {
  const response = await postAdmin(request("/api/admin/locations/supply-town/photo-supply", { action: "create_invite", by: "forged@example.test",
    source: { id: "street", name: "Main Street photos", evidence_url: "https://organizer.example/photos", scope: { kind: "street", name: "Main Street", city: "Supply Town", aliases: [], source_urls: [] } } }), adminContext);
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const inbox = await getAdmin(request("/api/admin/locations/supply-town/photo-supply"), adminContext);
  const data = await inbox.json();
  expect(data.invites[0].created_by).toBe("admin@example.test"); expect(data.invites[0]).not.toHaveProperty("_id");
});
