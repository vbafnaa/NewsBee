import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  assertPublicationContext,
  assertPublicationWrite,
  ensurePublicationIndexes,
  publicationOwnedDocument,
  publicationScopedFilter,
  resolvePrivilegedPublicationContext,
  resolvePublicationContext,
} from "../../publications/access";
import {
  appendPublicationAccessAudit,
  publicationAccessAuditIsIntact,
  type PublicationAccessAuditEvent,
} from "../../publications/audit";
import {
  PublicationAccessDenied,
  publicationCapabilities,
} from "../../publications/permissions";
import {
  createOutputChannel,
  listOutputChannelEditions,
  listOutputChannels,
  listOutputChannelsForPrincipal,
  resolveOutputChannel,
  resolveOutputChannelForPrincipal,
} from "../../orchestration/output-channels";
import { COLLECTIONS } from "../../storage/mongo";
import { enterPublicationSupport } from "../../publications/support";

const LOCATION = "shared-town-wa";
const FIRST = "1".repeat(32);
const SECOND = "2".repeat(32);
let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-tenancy");
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensurePublicationIndexes(db, true);
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

describe("publication tenancy foundation", () => {
  it("migrates the legacy release index concurrently without restricting unpublished drafts or losing release uniqueness", async () => {
    const collection = db.collection(COLLECTIONS.publicationDrafts);
    await collection.dropIndex("publication_release_identity_v2");
    await collection.createIndex({ publication_id: 1, "release.release_id": 1 }, {
      name: "publication_release_identity", unique: true, sparse: true,
    });
    await collection.insertMany([
      { publication_id: FIRST, generation_id: "unpublished-first" },
      { publication_id: FIRST, generation_id: "published-first", release: { release_id: "release-one" } },
    ]);

    await Promise.all(Array.from({ length: 4 }, () =>
      ensurePublicationIndexes(client.db(db.databaseName), true)));
    await ensurePublicationIndexes(db, true);

    const indexes = await collection.indexes();
    expect(indexes.some(({ name }) => name === "publication_release_identity")).toBe(false);
    expect(indexes.find(({ name }) => name === "publication_release_identity_v2")).toMatchObject({
      unique: true, partialFilterExpression: { "release.release_id": { $type: "string" } },
    });
    await collection.insertMany([
      { publication_id: FIRST, generation_id: "unpublished-second" },
      { publication_id: FIRST, generation_id: "unpublished-third" },
      { publication_id: SECOND, generation_id: "other-publication", release: { release_id: "release-one" } },
    ]);
    await expect(collection.insertOne({
      publication_id: FIRST, generation_id: "duplicate-release", release: { release_id: "release-one" },
    })).rejects.toMatchObject({ code: 11000 });
    expect(await collection.countDocuments({ publication_id: FIRST, release: { $exists: false } })).toBe(3);
    expect(await collection.countDocuments({ publication_id: FIRST, "release.release_id": "release-one" })).toBe(1);
  });

  it("runs the network-free two-publication isolation and legacy compatibility journey", async () => {
    await db.collection(COLLECTIONS.locations).insertOne({
      _id: LOCATION,
      id: LOCATION,
      name: "Shared Town, WA",
      state: "WA",
      systems: [],
    });
    await createOutputChannel(db, "journalist-one", FIRST, "first-folder", {
      name: "First Independent",
      destinations: [{ type: "reader", url: "" }],
      enabled: true,
      selectedLocationIds: [LOCATION],
    });
    await createOutputChannel(db, "journalist-two", SECOND, "second-folder", {
      name: "Second Independent",
      destinations: [{ type: "reader", url: "" }],
      enabled: true,
      selectedLocationIds: [LOCATION],
    });
    await db.collection(COLLECTIONS.outputChannels).updateOne(
      { _id: FIRST },
      { $unset: { publication_scope_version: "" } },
    );
    await db.collection(COLLECTIONS.outputChannelEditions).insertOne({
      _id: "legacy-edition",
      owner_id: "journalist-one",
      channel_id: FIRST,
      title: "Existing edition",
      output_modes: ["reader"],
      created_at: 1,
      stories: [],
      video_stories: [],
      edition_ids: [],
    });

    const first = await resolveOutputChannel(db, "journalist-one", FIRST);
    const second = await resolveOutputChannel(db, "journalist-two", SECOND);
    expect(first?.context.role).toBe("owner");
    expect(second?.context.role).toBe("owner");
    expect(await resolveOutputChannel(db, "journalist-one", SECOND)).toBeNull();
    expect(await resolveOutputChannel(db, "journalist-two", FIRST)).toBeNull();
    expect(() => assertPublicationContext(first!.context, SECOND)).toThrow(PublicationAccessDenied);
    expect(await listOutputChannels(db, "journalist-one")).toMatchObject([{ id: FIRST, selectedLocationIds: [LOCATION] }]);
    expect(await listOutputChannels(db, "journalist-two")).toMatchObject([{ id: SECOND, selectedLocationIds: [LOCATION] }]);
    expect(await db.collection(COLLECTIONS.outputChannels).countDocuments({ selected_location_ids: LOCATION })).toBe(2);

    await db.collection("publication_notes").insertMany([
      publicationOwnedDocument(first!.context, { body: "First newsroom private note" }),
      publicationOwnedDocument(second!.context, { body: "Second newsroom private note" }),
    ]);
    expect(await db.collection("publication_notes")
      .find(publicationScopedFilter(first!.context)).project({ _id: 0, body: 1 }).toArray())
      .toEqual([{ body: "First newsroom private note" }]);
    expect(await db.collection("publication_notes")
      .find(publicationScopedFilter(second!.context)).project({ _id: 0, body: 1 }).toArray())
      .toEqual([{ body: "Second newsroom private note" }]);

    expect(await listOutputChannelEditions(db, first!.context)).toMatchObject([{ _id: "legacy-edition" }]);
    expect(await db.collection(COLLECTIONS.outputChannelEditions).findOne({ _id: "legacy-edition" }))
      .toMatchObject({ publication_id: FIRST });
    expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: FIRST }))
      .toMatchObject({ publication_scope_version: 1 });
    await db.collection(COLLECTIONS.outputChannelEditions).insertOne({
      _id: "rolling-legacy-edition",
      owner_id: "journalist-one",
      channel_id: FIRST,
      title: "Edition from an older deployment",
      output_modes: ["reader"],
      created_at: 2,
      stories: [],
      video_stories: [],
      edition_ids: [],
    });
    expect(await listOutputChannelEditions(db, first!.context)).toMatchObject([
      { _id: "rolling-legacy-edition" },
      { _id: "legacy-edition", publication_id: FIRST },
    ]);
  });

  it("resolves explicit members without granting access to unrelated principals", async () => {
    await createOutputChannel(db, "publication-owner", FIRST, "first-folder", {
      name: "Member publication",
      destinations: [{ type: "reader", url: "" }],
      enabled: true,
      selectedLocationIds: [],
    });
    await db.collection(COLLECTIONS.outputChannels).updateOne(
      { _id: FIRST },
      { $set: { members: [{ principal_id: "publication-editor", role: "editor" }] } },
    );

    expect(await resolvePublicationContext(db, "publication-editor", FIRST)).toMatchObject({
      id: FIRST,
      ownerId: "publication-owner",
      principalId: "publication-editor",
      role: "editor",
    });
    expect(await resolvePublicationContext(db, "unrelated-editor", FIRST)).toBeNull();
  });

  it("grants audited support inspection to operators while editors remain publication-scoped", () => {
    expect([...publicationCapabilities({ role: "owner" })].sort()).toEqual([
      "publication:inspect",
      "publication:read",
      "publication:write",
    ]);
    expect([...publicationCapabilities({ role: "editor" })].sort()).toEqual([
      "publication:read",
      "publication:write",
    ]);
    expect([...publicationCapabilities({ role: "admin" })].sort()).toEqual([
      "publication:inspect",
      "publication:read",
      "publication:write",
    ]);
    expect(publicationCapabilities({ role: "owner" }).has("publication:inspect")).toBe(true);
    expect(publicationCapabilities({ role: "editor" }).has("publication:inspect")).toBe(false);
  });

  it("lists and resolves unassigned publications only through audited operator support access", async () => {
    await createOutputChannel(db, "publication-admin", FIRST, "first-folder", {
      name: "Supported publication",
      destinations: [{ type: "reader", url: "" }],
      enabled: true,
      selectedLocationIds: [],
    });
    const admin = {
      id: "support-admin",
      email: "support-admin@example.test",
      role: "admin" as const,
    };
    const owner = {
      id: "global-owner",
      email: "owner@example.test",
      role: "owner" as const,
    };
    const editor = {
      id: "unassigned-editor",
      email: "editor@example.test",
      role: "editor" as const,
    };

    await expect(listOutputChannelsForPrincipal(db, admin, "Review Admin Publications"))
      .resolves.toMatchObject([{ id: FIRST }]);
    await expect(resolveOutputChannelForPrincipal(db, admin, FIRST, "Open Admin support view"))
      .resolves.toMatchObject({ context: { role: "privileged", principalId: admin.id } });
    await expect(resolveOutputChannelForPrincipal(db, owner, FIRST, "Open owner support view"))
      .resolves.toMatchObject({ context: { role: "privileged", principalId: owner.id } });
    await db.collection("journalist_admins").insertOne({ principalId: admin.id, email: admin.email, role: "admin", enabled: true });
    await expect(resolveOutputChannelForPrincipal(db, admin, FIRST, "Update from Admin support view", "write"))
      .rejects.toThrow(PublicationAccessDenied);
    await enterPublicationSupport(db, admin, FIRST, "Resolve the reported publication issue");
    const elevated = await resolveOutputChannelForPrincipal(db, admin, FIRST, "Update from Admin support view", "write");
    expect(elevated).toMatchObject({ context: { role: "privileged", principalId: admin.id } });
    await assertPublicationWrite(db, elevated!.context, "publication_updated");
    await expect(listOutputChannelsForPrincipal(db, editor, "Attempted cross-publication list"))
      .resolves.toEqual([]);
    await expect(resolveOutputChannelForPrincipal(db, editor, FIRST, "Attempted cross-publication view"))
      .resolves.toBeNull();

    const events = await db.collection<PublicationAccessAuditEvent>(COLLECTIONS.publicationAccessAudit)
      .find().toArray();
    expect(events).toHaveLength(5);
    expect(events.map(({ principal_id, capability, action }) => ({ principal_id, capability, action })))
      .toEqual([
        { principal_id: admin.id, capability: "publication:inspect", action: "privileged_inspection" },
        { principal_id: admin.id, capability: "publication:inspect", action: "privileged_inspection" },
        { principal_id: owner.id, capability: "publication:inspect", action: "privileged_inspection" },
        { principal_id: admin.id, capability: "publication:write", action: "support_entered" },
        { principal_id: admin.id, capability: "publication:write", action: "privileged_write_access" },
      ]);
    expect(events.every(publicationAccessAuditIsIntact)).toBe(true);
  });

  it("allows explicit privileged inspection only with an append-only audit event", async () => {
    await createOutputChannel(db, "publication-owner", FIRST, "first-folder", {
      name: "Inspected publication",
      destinations: [{ type: "reader", url: "" }],
      enabled: true,
      selectedLocationIds: [],
    });
    const platformAdmin = {
      id: "platform-admin",
      email: "platform-admin@example.test",
      role: "admin" as const,
    };
    const context = await resolvePrivilegedPublicationContext(
      db,
      platformAdmin,
      FIRST,
      "Investigate a reported tenant isolation incident",
    );
    expect(context).toMatchObject({ id: FIRST, principalId: platformAdmin.id, role: "privileged" });
    const events = await db.collection<PublicationAccessAuditEvent>(COLLECTIONS.publicationAccessAudit).find().toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      publication_id: FIRST,
      principal_id: platformAdmin.id,
      capability: "publication:inspect",
      action: "privileged_inspection",
    });
    expect(publicationAccessAuditIsIntact(events[0])).toBe(true);
  });

  it("denies journalist cross-publication privileged access without writing an audit event", async () => {
    await createOutputChannel(db, "publication-owner", FIRST, "first-folder", {
      name: "Private publication",
      destinations: [{ type: "reader", url: "" }],
      enabled: true,
      selectedLocationIds: [],
    });
    await expect(resolvePrivilegedPublicationContext(db, {
      id: "unrelated-journalist",
      email: "journalist@example.test",
      role: "editor",
      capabilities: ["publication:inspect"],
    }, FIRST, "Attempted cross-publication access")).rejects.toBeInstanceOf(PublicationAccessDenied);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
  });

  it("appends audit events without overwriting prior rows and detects mutation", async () => {
    const base = {
      publication_id: FIRST,
      principal_id: "platform-admin",
      principal_email: "platform-admin@example.test",
      capability: "publication:inspect" as const,
      action: "privileged_inspection" as const,
    };
    const first = await appendPublicationAccessAudit(db, { ...base, reason: "First inspection" });
    await appendPublicationAccessAudit(db, { ...base, reason: "Follow-up inspection" });
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(2);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).findOne({ _id: first._id }))
      .toEqual(first);
    await db.collection(COLLECTIONS.publicationAccessAudit).updateOne(
      { _id: first._id },
      { $set: { reason: "Tampered reason" } },
    );
    const tampered = await db.collection<PublicationAccessAuditEvent>(COLLECTIONS.publicationAccessAudit)
      .findOne({ _id: first._id });
    expect(publicationAccessAuditIsIntact(tampered!)).toBe(false);
  });

  it("creates the publication list, location publish, and scoped edition indexes", async () => {
    const channelIndexes = await db.collection(COLLECTIONS.outputChannels).indexes();
    const editionIndexes = await db.collection(COLLECTIONS.outputChannelEditions).indexes();
    const auditIndexes = await db.collection(COLLECTIONS.publicationAccessAudit).indexes();
    expect(channelIndexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "publication_owner_list",
      "publication_member_list",
      "publication_location_publish",
    ]));
    expect(editionIndexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "publication_editions_recent",
      "publication_edition_stories",
      "legacy_channel_editions_recent",
    ]));
    expect(auditIndexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "publication_access_audit",
      "principal_access_audit",
    ]));
  });
});
