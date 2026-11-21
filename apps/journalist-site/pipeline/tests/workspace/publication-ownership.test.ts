import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { principalForEmail, type Principal } from "../../accounts/identity";
import { deleteAccessAccount, updateAccessPolicy } from "../../accounts/access-policy";
import { COLLECTIONS } from "../../storage/mongo";
import { publicationOwnership, transferPublicationOwnership } from "../../publications/ownership";
import { publicationAccessAuditIsIntact, type PublicationChangeAuditEvent } from "../../publications/audit";

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let owner: Principal;
const publicationId = "publication-one";
const transfer = { revision: 0, successorId: "successor", formerOwnerMembership: "remove" as const, reason: "Editorial handoff" };

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-ownership");
});
afterAll(async () => { await client?.close(); await server?.stop(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await db.dropDatabase();
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "workspace-owner@example.test");
  owner = (await principalForEmail(db, "workspace-owner@example.test"))!;
  await db.collection("journalist_admins").insertMany([
    { principalId: "former", email: "former@example.test", role: "editor", enabled: true, revision: 0 },
    { principalId: "successor", email: "successor@example.test", role: "admin", enabled: true, revision: 0 },
    { principalId: "unassigned", email: "unassigned@example.test", role: "editor", enabled: true, revision: 0 },
  ]);
  await db.collection(COLLECTIONS.outputChannels).insertOne({
    _id: publicationId, owner_id: "former", name: "Original publication",
    members: [{ principal_id: "successor", role: "editor" }],
    selected_location_ids: ["town"], published_location_ids: ["historic-town"],
    reader_publication: { latest_release_id: "release-1", manifest_file_id: "immutable" },
  });
  await db.collection(COLLECTIONS.outputChannelEditions).insertOne({
    _id: "legacy", owner_id: "former", channel_id: publicationId, content: "unchanged",
  });
});

describe("workspace-owned publication transfer", () => {
  it.each(["retain", "remove"] as const)("preserves identity, releases and legacy scope with the explicit %s membership outcome", async (membership) => {
    const before = await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
    expect(await publicationOwnership(db, owner, publicationId)).toMatchObject({
      revision: 0, ownerId: "former", candidates: [{ principalId: "successor", email: "successor@example.test" }],
    });
    await db.collection(COLLECTIONS.publicationGenerations).insertOne({ publication_id: publicationId, status: "ready" });
    await transferPublicationOwnership(db, owner, publicationId, { ...transfer, formerOwnerMembership: membership });
    const after = await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
    expect(after).toMatchObject({
      ...before, owner_id: "successor", lifecycle_revision: 1, publication_scope_version: 1,
      members: [{ principal_id: "successor", role: "editor" }, ...(membership === "retain" ? [{ principal_id: "former", role: "editor" }] : [])],
    });
    expect(await db.collection(COLLECTIONS.outputChannelEditions).findOne({ _id: "legacy" }))
      .toMatchObject({ publication_id: publicationId, owner_id: "former", content: "unchanged" });
    const event = await db.collection<PublicationChangeAuditEvent>(COLLECTIONS.publicationAccessAudit).findOne({ action: "ownership_transferred" });
    expect(event).toMatchObject({
      principal_email: owner.email, resource_id: "successor",
      target_principal_id: "successor", target_email: "successor@example.test",
      previous_owner_id: "former", previous_owner_email: "former@example.test", former_owner_membership: membership,
    });
    expect(event?.detail).toContain("successor@example.test");
    expect(publicationAccessAuditIsIntact(event!)).toBe(true);
    await expect(deleteAccessAccount(db, owner, { targetPrincipalId: "successor", expectedRevision: 0 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("rejects publication-owner impersonation, unassigned/disabled targets, active work and stale revisions before mutation", async () => {
    await expect(transferPublicationOwnership(db, { id: "former", email: "former@example.test", role: "editor" }, publicationId, transfer))
      .rejects.toMatchObject({ status: 403 });
    await expect(transferPublicationOwnership(db, owner, publicationId, { ...transfer, successorId: "unassigned" }))
      .rejects.toMatchObject({ status: 409 });
    await db.collection("journalist_admins").updateOne({ principalId: "successor" }, { $set: { enabled: false } });
    await expect(transferPublicationOwnership(db, owner, publicationId, transfer)).rejects.toMatchObject({ status: 409 });
    await db.collection("journalist_admins").updateOne({ principalId: "successor" }, { $set: { enabled: true } });
    for (const status of ["running", "blocked", "paused", "cancelling"]) {
      await db.collection(COLLECTIONS.publicationGenerations).insertOne({ publication_id: publicationId, status });
      await expect(transferPublicationOwnership(db, owner, publicationId, transfer)).rejects.toMatchObject({ status: 409 });
      await db.collection(COLLECTIONS.publicationGenerations).deleteMany({});
    }
    await expect(transferPublicationOwnership(db, owner, publicationId, { ...transfer, revision: 3 })).rejects.toMatchObject({ status: 409 });
    expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId })).toMatchObject({ owner_id: "former" });
    expect(await db.collection(COLLECTIONS.outputChannelEditions).findOne({ _id: "legacy" })).not.toHaveProperty("publication_id");
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
  });

  it("serializes transfer against deliberate assignment removal and preserves the explicit removal outcome", async () => {
    const results = await Promise.allSettled([
      transferPublicationOwnership(db, owner, publicationId, transfer),
      updateAccessPolicy(db, owner, { targetPrincipalId: "successor", expectedRevision: 0, publicationIds: [] }),
    ]);
    const publication = await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
    const transferred = results[0].status === "fulfilled";
    expect(publication?.owner_id).toBe(transferred ? "successor" : "former");
    if (transferred) expect(publication?.members.some((member: { principal_id: string }) => member.principal_id === "former")).toBe(false);
    else expect(results[0]).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  });

  it("rolls back owner and legacy scope changes when the retained audit cannot be written", async () => {
    await db.createCollection(COLLECTIONS.publicationAccessAudit, {
      validator: { blocked: { $exists: true } }, validationLevel: "strict",
    });
    await expect(transferPublicationOwnership(db, owner, publicationId, transfer)).rejects.toThrow();
    expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId }))
      .toMatchObject({ owner_id: "former" });
    expect(await db.collection(COLLECTIONS.outputChannelEditions).findOne({ _id: "legacy" })).not.toHaveProperty("publication_id");
    expect(await db.collection("journalist_admins").findOne({ principalId: "successor" }))
      .not.toHaveProperty("publicationOwnershipSequence");
  });
});
