import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PATCH, POST } from "../../../app/api/admin/output-channels/route";
import { PublicationAccessDenied } from "../../publications/permissions";
import { publicationAccessAuditIsIntact, type PublicationAccessAuditEvent } from "../../publications/audit";
import { createOutputChannel, outputChannels } from "../../orchestration/output-channels";
import { COLLECTIONS } from "../../storage/mongo";
import { enterPublicationSupport } from "../../publications/support";

const state = vi.hoisted(() => ({
  db: null as Db | null,
  removeFile: vi.fn(async () => 0),
  saveJson: vi.fn(async (_folder: string, _name: string, _value: unknown) => "file"),
  storeKind: "local" as "local" | "drive",
  driveAuthorized: false,
  reserveDriveFolder: vi.fn(async () => "reserved-drive-folder"),
  provisionDriveFolder: vi.fn(async () => {}),
  principal: { id: "route-owner", email: "route-owner@example.test", role: "owner" } as {
    id: string;
    email: string;
    role: "owner" | "admin" | "editor";
  },
}));
vi.mock("@/lib/admin-api", () => ({
  adminRoute: async (_request: Request, handler: (deps: unknown) => Promise<unknown>) => {
    const result = await handler({
      db: state.db!,
      principal: state.principal,
      settings: { mode: "local" },
      store: {
        kind: state.storeKind,
        removeFile: state.removeFile, saveJson: state.saveJson,
      },
    });
    return result instanceof Response ? result : Response.json(result);
  },
  publicationRoute: async (_request: Request, handler: (deps: unknown) => Promise<unknown>) => {
    try { const result = await handler({
      db: state.db!,
      principal: state.principal,
      settings: { mode: "local" },
      store: {
        kind: state.storeKind,
        removeFile: state.removeFile, saveJson: state.saveJson,
      },
    });
    return result instanceof Response ? result : Response.json(result);
    } catch (error) {
      if (error instanceof PublicationAccessDenied) return Response.json({ detail: error.message }, { status: 403 });
      throw error;
    }
  },
  jsonBody: (request: Request) => request.json(),
}));
vi.mock("@/pipeline/storage/user-drive", () => ({
  hasGoogleDriveAuthorization: async () => state.driveAuthorized,
  reserveUserDriveFolderId: state.reserveDriveFolder,
  provisionUserDriveChannelFolder: state.provisionDriveFolder,
}));
vi.mock("@/lib/admin-session", () => ({
  ownerGuard: async () => state.principal.role === "owner"
    ? null
    : Response.json({ detail: "Owner access required" }, { status: 403 }),
}));

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
const publicationId = "d".repeat(32);

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("output-channel-routes");
});

beforeEach(async () => {
  await db.dropDatabase();
  state.db = db;
  state.principal = { id: "route-owner", email: "route-owner@example.test", role: "owner" };
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", state.principal.email);
  state.removeFile.mockClear(); state.saveJson.mockReset().mockResolvedValue("file");
  state.reserveDriveFolder.mockReset().mockResolvedValue("reserved-drive-folder");
  state.provisionDriveFolder.mockReset().mockResolvedValue();
  state.driveAuthorized = false; state.storeKind = "local";
  await db.collection("journalist_admins").insertMany([
    { email: state.principal.email, principalId: state.principal.id, enabled: true, role: "owner" },
    { email: "support-admin@example.test", principalId: "support-admin", enabled: true, role: "admin" },
    { email: "journalist@example.test", principalId: "journalist", enabled: true, role: "editor" },
  ]);
  await createOutputChannel(db, "route-owner", publicationId, "publication-folder", {
    name: "Protected publication",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: [],
  });
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
  vi.unstubAllEnvs();
});

it("lists safe newsroom directory entries without inspecting unopened newsrooms", async () => {
  const secondPublicationId = "e".repeat(32);
  await createOutputChannel(db, "another-owner", secondPublicationId, "another-folder", {
    name: "Another publication",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: [],
  });
  state.principal = { id: "support-admin", email: "support-admin@example.test", role: "admin" };

  const response = await GET(new Request("https://fixture.example.test/api/admin/output-channels"));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    channels: [], directory: [{ id: secondPublicationId, accessMode: "inspection" }, { id: publicationId, accessMode: "inspection" }],
  });
  const events = await db.collection<PublicationAccessAuditEvent>(COLLECTIONS.publicationAccessAudit).find().toArray();
  expect(events).toHaveLength(0);
});

it("projects direct access separately from inspection and expiring support", async () => {
  const url = `https://fixture.example.test/api/admin/output-channels?channelId=${publicationId}`;
  await expect((await GET(new Request(url))).json()).resolves.toMatchObject({
    channels: [{ id: publicationId, accessMode: "direct", canWrite: true, supportExpiresAt: null }],
  });
  state.principal = { id: "support-admin", email: "support-admin@example.test", role: "admin" };
  await expect((await GET(new Request(url))).json()).resolves.toMatchObject({
    channels: [{ accessMode: "inspection", canWrite: false, supportExpiresAt: null }],
  });
  const support = await enterPublicationSupport(db, state.principal, publicationId, "Investigate the newsroom coverage settings");
  await expect((await GET(new Request(url))).json()).resolves.toMatchObject({
    channels: [{ accessMode: "support", canWrite: true, supportExpiresAt: support.expires_at }],
  });
  await db.collection("publication_support_sessions").updateOne({ _id: support._id }, { $set: { expires_at: Date.now() - 1 } });
  await expect((await GET(new Request(url))).json()).resolves.toMatchObject({
    channels: [{ accessMode: "inspection", canWrite: false, supportExpiresAt: null }],
  });
  const update = () => PATCH(new Request("https://fixture.example.test/api/admin/output-channels", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: publicationId, lifecycleRevision: 0, name: "Assigned admin newsroom",
      destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [] }),
  }));
  expect((await update()).status).toBe(403);
  await outputChannels(db).updateOne({ _id: publicationId }, {
    $set: { members: [{ principal_id: state.principal.id, role: "editor" }] },
  });
  await expect((await GET(new Request(url))).json()).resolves.toMatchObject({
    channels: [{ accessMode: "direct", canWrite: true, supportExpiresAt: null }],
  });
  expect((await update()).status).toBe(200);
  state.principal = { id: "journalist", email: "journalist@example.test", role: "editor" };
  expect((await GET(new Request(url))).status).toBe(404);
});

it("denies editor archival before changing another owner's publication", async () => {
  state.principal = { id: "journalist", email: "journalist@example.test", role: "editor" };

  const response = await DELETE(new Request("https://fixture.example.test/api/admin/output-channels", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: publicationId }),
  }));

  expect(response.status).toBe(403);
  expect(await outputChannels(db).findOne({ _id: publicationId })).not.toBeNull();
  expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
});

it("denies an admin Reader removal before clearing another owner's publication artifacts", async () => {
  state.principal = { id: "support-admin", email: "support-admin@example.test", role: "admin" };

  const response = await PATCH(new Request("https://fixture.example.test/api/admin/output-channels", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: publicationId,
      lifecycleRevision: 0,
      name: "Protected publication",
      destinations: [{ type: "video", url: "" }],
      enabled: true,
      selectedLocationIds: [],
    }),
  }));

  expect(response.status).toBe(403);
  expect(await outputChannels(db).findOne({ _id: publicationId })).toMatchObject({
    destinations: [{ type: "reader", url: "" }],
  });
  const events = await db.collection<PublicationAccessAuditEvent>(COLLECTIONS.publicationAccessAudit).find().toArray();
  expect(events).toHaveLength(0);
});

it.each(["approved", "publishing"])("blocks publication deletion while a draft is %s", async (status) => {
  await db.collection(COLLECTIONS.publicationDrafts).insertOne({
    _id: `draft-${status}`,
    publication_id: publicationId,
    editorial_status: status,
  });
  const response = await DELETE(new Request("https://fixture.example.test/api/admin/output-channels", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: publicationId, lifecycleRevision: 0 }),
  }));
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({
    detail: expect.stringContaining("approved or publishing drafts"),
  });
  expect(await outputChannels(db).findOne({ _id: publicationId })).not.toBeNull();
});

it.each([
  { publicationId, enabled: true }, { publicationId, enabled: false },
  { publicationId: "reader-site", enabled: true }, { publicationId: "reader-site", enabled: false },
])("admin archive/restore of $publicationId retains immutable history and previous enabled=$enabled", async ({ publicationId, enabled }) => {
  if (publicationId === "reader-site") await createOutputChannel(db, "route-owner", publicationId, "publication-folder", {
    name: "Legacy Reader", destinations: [{ type: "reader", url: "" }], enabled, selectedLocationIds: [],
  });
  state.principal = { id: "support-admin", email: "support-admin@example.test", role: "admin" };
  const pointer = { manifest_file_id: "manifest", latest_release_id: "release", manifest_revision: 3,
    latest_published_at: 123, location_ids: [], locations: [], publication: null };
  await outputChannels(db).updateOne({ _id: publicationId }, { $set: { enabled, reader_publication: pointer } });
  await db.collection(COLLECTIONS.publicationDrafts).insertOne({
    _id: "published", publication_id: publicationId, editorial_status: "published", release: { release_id: "release" },
  });
  await db.collection(COLLECTIONS.outputChannelFiles).insertOne({ folder_id: "publication-folder", name: "manifest.json", payload: "immutable" });
  const request = (method: string, value: Record<string, unknown>) => new Request("https://fixture.example.test/api/admin/output-channels", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: publicationId, ...value }),
  });
  expect((await DELETE(request("DELETE", { lifecycleRevision: 0 }))).status).toBe(200);
  expect(await outputChannels(db).findOne({ _id: publicationId })).toMatchObject({
    enabled: false, archived_at: expect.any(Number), archived_by: "support-admin", archived_was_enabled: enabled,
    lifecycle_revision: 1, reader_publication: pointer,
  });
  const directory = await (await GET(new Request("https://fixture.example.test/api/admin/output-channels"))).json();
  expect(directory.directory).toContainEqual(expect.objectContaining({ id: publicationId, archivedAt: expect.any(Number), lifecycleRevision: 1 }));
  expect((await PATCH(request("PATCH", {
    lifecycleRevision: 1, name: "Bypass", enabled: true, destinations: [{ type: "reader", url: "" }], selectedLocationIds: [],
  }))).status).toBe(403);
  expect((await PATCH(request("PATCH", { lifecycleRevision: 0, action: "restore" }))).status).toBe(409);
  expect((await PATCH(request("PATCH", { lifecycleRevision: 1, action: "restore" }))).status).toBe(200);
  const restored = await outputChannels(db).findOne({ _id: publicationId });
  expect(restored).toMatchObject({ enabled, lifecycle_revision: 2, reader_publication: pointer });
  expect(restored).not.toHaveProperty("archived_at");
  expect(restored).not.toHaveProperty("archived_by");
  expect(restored).not.toHaveProperty("archived_was_enabled");
  expect(await db.collection(COLLECTIONS.publicationDrafts).countDocuments()).toBe(1);
  expect(await db.collection(COLLECTIONS.outputChannelFiles).countDocuments()).toBe(1);
  expect(state.removeFile).not.toHaveBeenCalled();
  expect(state.saveJson).not.toHaveBeenCalled();
  const events = await db.collection<PublicationAccessAuditEvent>(COLLECTIONS.publicationAccessAudit).find({ action: { $in: ["publication_archived", "publication_restored"] } }).toArray();
  expect(events).toHaveLength(2);
  expect(events.every(publicationAccessAuditIsIntact)).toBe(true);
});

it.each(["generation", "video", "upload", "manifest"])("blocks archive during active %s work", async (kind) => {
  if (kind === "generation") await db.collection(COLLECTIONS.publicationGenerations).insertOne({ publication_id: publicationId, status: "paused" });
  if (kind === "video") await db.collection(COLLECTIONS.videoJobs).insertOne({ publication_id: publicationId, status: "processing" });
  if (kind === "upload") await db.collection(COLLECTIONS.videoUploadSessions).insertOne({ publication_id: publicationId, status: "finalizing" });
  if (kind === "manifest") await outputChannels(db).updateOne({ _id: publicationId }, { $set: { reader_manifest_claim: { token: "active", claimed_at: 1 } } });
  const response = await DELETE(new Request("https://fixture.example.test/api/admin/output-channels", {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: publicationId, lifecycleRevision: 0 }),
  }));
  expect(response.status).toBe(409);
  expect(await outputChannels(db).findOne({ _id: publicationId })).not.toHaveProperty("archived_at");
  expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
});

it("rechecks the stored actor rather than trusting a stale Admin session", async () => {
  state.principal = { id: "support-admin", email: "support-admin@example.test", role: "admin" };
  await db.collection("journalist_admins").updateOne({ principalId: state.principal.id }, { $set: { enabled: false } });
  const response = await DELETE(new Request("https://fixture.example.test/api/admin/output-channels", {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: publicationId, lifecycleRevision: 0 }),
  }));
  expect(response.status).toBe(403);
  expect(await outputChannels(db).findOne({ _id: publicationId })).not.toHaveProperty("archived_at");
});

it("does not allow direct newsroom settings to re-enable an archived publication", async () => {
  await DELETE(new Request("https://fixture.example.test/api/admin/output-channels", {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: publicationId, lifecycleRevision: 0 }),
  }));
  const response = await PATCH(new Request("https://fixture.example.test/api/admin/output-channels", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
      id: publicationId, lifecycleRevision: 1, name: "Bypass", enabled: true,
      destinations: [{ type: "reader", url: "" }], selectedLocationIds: [],
    }),
  }));
  expect(response.status).toBe(409);
  expect(await outputChannels(db).findOne({ _id: publicationId })).toMatchObject({ enabled: false, lifecycle_revision: 1 });
});

describe("publication coverage governance", () => {
  function request(method: string, value: Record<string, unknown>) {
    return new Request("https://fixture.example.test/api/admin/output-channels", {
      method, headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(method === "POST" ? { requestKey: "creation-request-fixture" } : {}), ...value }),
    });
  }

  const settings = {
    name: "Updated publication", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [],
  };

  async function readyCommunity(id: string) {
    await db.collection(COLLECTIONS.locations).insertOne({
      _id: id, id, name: id, state: "WA", systems: [], source_map_at: 1,
      source_coverage: { status: "ready", gaps: [] },
      preparation: { state: "ready", updated_at: "2026-11-17", updated_by: "route-owner" },
    } as never);
    await db.collection("source_map").insertOne({ location_id: id, status: "active", link_only: false });
  }

  it("uses the legacy serialized ID unchanged to attach Ready coverage, preserving sources and memberships", async () => {
    const id = "reader-site";
    await readyCommunity("moses-lake-wa");
    await db.collection(COLLECTIONS.locations).insertOne({
      _id: "ballard-seattle-wa", id: "ballard-seattle-wa", name: "Ballard", state: "WA", systems: [],
      source_map_at: 1, source_coverage: { status: "ready", gaps: [] },
    });
    await createOutputChannel(db, "route-owner", id, "legacy-reader-folder", {
      name: "Legacy Reader", destinations: [{ type: "reader", url: "" }], enabled: true, selectedLocationIds: [],
    });
    const sources = await db.collection("source_map").find({}).toArray();
    const save = (locationId: string, lifecycleRevision = 0) => PATCH(request("PATCH", {
      ...settings, id, lifecycleRevision, allowedLocationIds: [locationId], selectedLocationIds: [locationId],
    }));
    expect((await save("ballard-seattle-wa")).status).toBe(422);
    expect((await save("moses-lake-wa")).status).toBe(200);
    expect(await outputChannels(db).findOne({ _id: id })).toMatchObject({
      _id: "reader-site", allowed_location_ids: ["moses-lake-wa"], selected_location_ids: ["moses-lake-wa"],
      lifecycle_revision: 1, owner_id: "route-owner", members: [],
    });
    expect((await save("moses-lake-wa")).status).toBe(409);
    expect(await db.collection("source_map").find({}).toArray()).toEqual(sources);
    expect(await outputChannels(db).countDocuments({ _id: id })).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({ publication_id: id, action: "allowed_communities_updated" })).toBe(1);
  });

  it.each(["PATCH", "DELETE"])("rejects malformed %s channel IDs without interpreting Mongo operators or normalizing identity", async (method) => {
    const handler = method === "PATCH" ? PATCH : DELETE;
    for (const id of [{ $ne: null }, "", " reader-site", "reader-site ", "reader/site", "x".repeat(257)]) {
      expect((await handler(request(method, { ...settings, id, lifecycleRevision: 0 }))).status).toBe(422);
    }
    expect((await handler(request(method, { ...settings, id: "missing-legacy-site", lifecycleRevision: 0 }))).status).toBe(method === "PATCH" ? 403 : 404);
    expect(await outputChannels(db).countDocuments()).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
    expect(state.removeFile).not.toHaveBeenCalled();
  });

  it("creates a publication for an Admin with exactly the validated initial boundary", async () => {
    await readyCommunity("ready");
    state.principal = { id: "support-admin", email: "support-admin@example.test", role: "admin" };
    const response = await POST(request("POST", { ...settings, selectedLocationIds: ["ready"] }));
    expect(response.status).toBe(201);
    const { channel } = await response.json();
    expect(channel).toMatchObject({ allowedLocationIds: ["ready"], selectedLocationIds: ["ready"], lifecycleRevision: 0 });
    expect(await outputChannels(db).findOne({ _id: channel.id })).toMatchObject({ owner_id: "support-admin", members: [] });
    expect(await db.collection("journalist_admins").findOne({ principalId: "support-admin" })).toMatchObject({ role: "admin" });
    const audit = await db.collection<PublicationAccessAuditEvent>(COLLECTIONS.publicationAccessAudit).findOne({ publication_id: channel.id });
    expect(audit).toMatchObject({
      action: "publication_created", principal_id: "support-admin",
      before_hash: null, after_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(publicationAccessAuditIsIntact(audit!)).toBe(true);
  });

  it("denies journalist creation before records, artifact allocation or provisioning", async () => {
    state.principal = { id: "journalist", email: "journalist@example.test", role: "editor" };
    state.storeKind = "drive"; state.driveAuthorized = true;
    expect((await POST(request("POST", settings))).status).toBe(403);
    expect(await outputChannels(db).countDocuments()).toBe(1);
    expect(await db.collection(COLLECTIONS.outputChannelCreations).countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
    expect(state.reserveDriveFolder).not.toHaveBeenCalled();
    expect(state.provisionDriveFolder).not.toHaveBeenCalled();
    expect(state.saveJson).not.toHaveBeenCalled();
    await expect((await GET(new Request("https://fixture.example.test/api/admin/output-channels"))).json())
      .resolves.toMatchObject({ canCreateNewsrooms: false });
  });

  it("rejects non-Ready and oversized creation selections before allocating artifacts", async () => {
    expect((await POST(request("POST", { ...settings, selectedLocationIds: ["not-ready"] }))).status).toBe(422);
    expect((await POST(request("POST", { ...settings, selectedLocationIds: Array.from({ length: 1001 }, (_, index) => `town-${index}`) }))).status).toBe(422);
    expect(await outputChannels(db).countDocuments()).toBe(1);
    expect(state.saveJson).not.toHaveBeenCalled();
  });

  it("creates without provider authorization using the existing Mongo folder fallback", async () => {
    state.principal = { id: "support-admin", email: "support-admin@example.test", role: "admin" };
    state.storeKind = "drive";
    const response = await POST(request("POST", settings));
    expect(response.status).toBe(201);
    const { channel } = await response.json();
    expect(channel.driveFolderId).toBe(`mongo:${channel.id}`);
    expect(channel.allowedLocationIds).toEqual([]);
    expect(state.reserveDriveFolder).not.toHaveBeenCalled();
    expect(state.provisionDriveFolder).not.toHaveBeenCalled();
  });

  it("returns the same durable newsroom and one audit after a lost response; changed payload conflicts", async () => {
    const first = await POST(request("POST", settings));
    const original = (await first.json()).channel;
    const retry = await POST(request("POST", settings));
    expect(retry.status).toBe(201);
    expect((await retry.json()).channel).toEqual(original);
    expect(await outputChannels(db).countDocuments()).toBe(2);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({ action: "publication_created" })).toBe(1);
    expect(state.saveJson).not.toHaveBeenCalled();
    expect((await POST(request("POST", { ...settings, name: "Changed details" }))).status).toBe(409);
    state.principal = { id: "support-admin", email: "support-admin@example.test", role: "admin" };
    const anotherActor = await POST(request("POST", settings));
    expect(anotherActor.status).toBe(201);
    expect((await anotherActor.json()).channel.id).not.toBe(original.id);
  });

  it("resumes failed folder provisioning using the reserved destination without reporting success early", async () => {
    state.storeKind = "drive"; state.driveAuthorized = true;
    state.provisionDriveFolder.mockRejectedValueOnce(new Error("Fixture storage unavailable"));
    await expect(POST(request("POST", settings))).rejects.toThrow("Fixture storage unavailable");
    expect(await outputChannels(db).countDocuments()).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
    const pending = await db.collection(COLLECTIONS.outputChannelCreations).findOne();
    expect(pending).toMatchObject({ complete: false, folder: { id: "reserved-drive-folder", drive: true } });
    await db.collection(COLLECTIONS.outputChannelCreations).updateOne({ _id: pending!._id }, {
      $set: { token: "abandoned-worker", lease_until: Date.now() - 1 },
    });
    const retry = await POST(request("POST", settings));
    expect(retry.status).toBe(201);
    expect((await retry.json()).channel.driveFolderId).toBe(pending!.folder.id);
    expect(await outputChannels(db).countDocuments()).toBe(2);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({ action: "publication_created" })).toBe(1);
    expect(state.reserveDriveFolder).toHaveBeenCalledTimes(1);
    expect(state.provisionDriveFolder).toHaveBeenCalledTimes(2);
    expect(state.saveJson).not.toHaveBeenCalled();
  });

  it("serializes concurrent same-key requests before provisioning", async () => {
    state.storeKind = "drive"; state.driveAuthorized = true;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    state.provisionDriveFolder.mockImplementationOnce(async () => { started(); await gate; });
    const first = POST(request("POST", settings));
    await entered;
    try { expect((await POST(request("POST", settings))).status).toBe(409); }
    finally { release(); }
    expect((await first).status).toBe(201);
    expect((await POST(request("POST", settings))).status).toBe(201);
    expect(state.provisionDriveFolder).toHaveBeenCalledTimes(1);
    expect(state.saveJson).not.toHaveBeenCalled();
    expect(await outputChannels(db).countDocuments()).toBe(2);
  });

  it("cannot reset a materialized directory when a stale provisioning attempt finishes after lease takeover", async () => {
    state.storeKind = "drive"; state.driveAuthorized = true;
    const files = new Map<string, unknown>();
    state.saveJson.mockImplementation(async (folder, name, value) => {
      files.set(`${folder}:${name}`, value);
      return "file";
    });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    state.provisionDriveFolder.mockImplementationOnce(async () => { started(); await gate; });
    const stale = POST(request("POST", settings));
    await entered;
    try {
      await db.collection(COLLECTIONS.outputChannelCreations).updateOne({}, { $set: { lease_until: Date.now() - 1 } });
      const resumed = await POST(request("POST", settings));
      expect(resumed.status).toBe(201);
      const { channel } = await resumed.json();
      const publishedDirectory = { locations: [{ id: "published-town", name: "Published Town" }] };
      await state.saveJson(channel.driveFolderId, "locations.json", publishedDirectory);
      release();
      expect((await stale).status).toBe(409);
      expect(files.get(`${channel.driveFolderId}:locations.json`)).toEqual(publishedDirectory);
      expect(files.size).toBe(1);
      expect(state.saveJson).toHaveBeenCalledTimes(1);
      expect(state.reserveDriveFolder).toHaveBeenCalledTimes(1);
      expect(await outputChannels(db).countDocuments()).toBe(2);
      expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({ action: "publication_created" })).toBe(1);
    } finally { release(); await stale; }
  });

  it("lets assigned journalists select Ready coverage but never widen the workspace boundary, even as publication owner", async () => {
    await readyCommunity("allowed"); await readyCommunity("outside");
    await outputChannels(db).updateOne({ _id: publicationId }, {
      $set: { owner_id: "journalist", allowed_location_ids: ["allowed"], selected_location_ids: [] },
    });
    state.principal = { id: "journalist", email: "journalist@example.test", role: "editor" };
    const save = await PATCH(request("PATCH", {
      ...settings, id: publicationId, lifecycleRevision: 0, selectedLocationIds: ["allowed"],
    }));
    expect(save.status).toBe(200);
    await expect(save.json()).resolves.toMatchObject({ channel: { lifecycleRevision: 1, selectedLocationIds: ["allowed"] } });
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).findOne({ action: "coverage_updated" })).toMatchObject({
      before_hash: expect.stringMatching(/^[a-f0-9]{64}$/), after_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await PATCH(request("PATCH", {
      ...settings, id: publicationId, lifecycleRevision: 1, selectedLocationIds: ["outside"],
    }))).status).toBe(403);
    expect((await PATCH(request("PATCH", {
      ...settings, id: publicationId, lifecycleRevision: 1, allowedLocationIds: ["allowed", "outside"],
    }))).status).toBe(403);
  });

  it.each(["owner", "admin"] as const)("allows a workspace %s to change the explicit boundary with CAS", async (role) => {
    await readyCommunity("allowed");
    if (role === "admin") {
      state.principal = { id: "support-admin", email: "support-admin@example.test", role: "admin" };
      await outputChannels(db).updateOne({ _id: publicationId }, {
        $set: { members: [{ principal_id: state.principal.id, role: "editor" }] },
      });
    }
    const response = await PATCH(request("PATCH", {
      ...settings, id: publicationId, lifecycleRevision: 0, allowedLocationIds: ["allowed"], selectedLocationIds: ["allowed"],
    }));
    expect(response.status).toBe(200);
    expect(await outputChannels(db).findOne({ _id: publicationId })).toMatchObject({
      allowed_location_ids: ["allowed"], selected_location_ids: ["allowed"], lifecycle_revision: 1,
    });
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).findOne({ action: "allowed_communities_updated" })).toMatchObject({
      before_hash: expect.stringMatching(/^[a-f0-9]{64}$/), after_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each(["PATCH", "DELETE"])("returns 409 for stale %s before cleanup, audit or document changes", async (method) => {
    await outputChannels(db).updateOne({ _id: publicationId }, { $set: { lifecycle_revision: 3 } });
    const before = await outputChannels(db).findOne({ _id: publicationId });
    const response = await (method === "PATCH" ? PATCH : DELETE)(request(method, {
      ...settings, id: publicationId, lifecycleRevision: 0, destinations: [{ type: "video", url: "" }],
    }));
    expect(response.status).toBe(409);
    expect(await outputChannels(db).findOne({ _id: publicationId })).toEqual(before);
    expect(state.removeFile).not.toHaveBeenCalled();
    expect(state.saveJson).not.toHaveBeenCalled();
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
  });
});
