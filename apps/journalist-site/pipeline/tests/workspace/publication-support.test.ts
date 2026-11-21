import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { fencedDatabase, MaintenanceError, readRestoreEvidence, RESTORE_EVIDENCE, RESTORE_STATE } from "../../../../../shared/restore-maintenance";
import type { Principal } from "../../accounts/identity";
import { AccessPolicyError, type AccessPolicyAuditEvent } from "../../accounts/access-policy";
import {
  assertPublicationWrite, authorizedPublicationFilter, resolvePrivilegedPublicationContext,
  resolvePublicationContext, type PublicationContext,
} from "../../publications/access";
import { appendPublicationAccessAudit, appendPublicationChangeAudit, publicationAccessAuditIsIntact } from "../../publications/audit";
import { listGovernanceAudit } from "../../publications/governance-audit";
import { activePublicationSupport, enterPublicationSupport, exitPublicationSupport } from "../../publications/support";
import { updatePublicationSettings } from "../../publications/settings";
import { patchPublicationDraft } from "../../publications/editorial";
import { approvePublicationDraft, createPublicationCorrection } from "../../publications/releases";
import { PublicationAccessDenied } from "../../publications/permissions";
import { COLLECTIONS } from "../../storage/mongo";

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
const admin: Principal = { id: "operator", email: "operator@example.test", role: "admin" };
const owner: Principal = { id: "workspace-owner", email: "owner@example.test", role: "owner" };
const journalist: Principal = { id: "reporter", email: "reporter@example.test", role: "editor" };
const publicationId = "publication-one";

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-support");
});
beforeEach(async () => {
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", owner.email);
  await db.dropDatabase();
  await db.collection("journalist_admins").insertMany([owner, admin, journalist].map((principal) => ({
    principalId: principal.id, email: principal.email, role: principal.role, enabled: true,
  })));
  await db.collection(COLLECTIONS.outputChannels).insertMany([
    { _id: publicationId, name: "One", owner_id: "another-owner", members: [{ principal_id: journalist.id, role: "editor" }], publication_scope_version: 1 },
    { _id: "publication-two", name: "Two", owner_id: "other-owner", publication_scope_version: 1 },
  ]);
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

describe("deliberate publication-bound support authority", () => {
  it("keeps broad operator reads but rejects hardcoded reasons, forged contexts and read-context writes at services", async () => {
    const read = await resolvePrivilegedPublicationContext(db, admin, publicationId, "Inspect publication");
    expect(read?.role).toBe("privileged");
    await expect(resolvePrivilegedPublicationContext(db, admin, publicationId, "A hardcoded reason is not authorization", "write"))
      .rejects.toThrow(PublicationAccessDenied);
    await enterPublicationSupport(db, admin, publicationId, "Investigate the reported editorial issue");
    await expect(assertPublicationWrite(db, read!, "attempt_write")).rejects.toThrow(PublicationAccessDenied);
    await expect(updatePublicationSettings(db, read!, admin, {})).rejects.toThrow(PublicationAccessDenied);
    await expect(patchPublicationDraft(db, read!, "draft", 0, { type: "ready_for_approval" }, admin)).rejects.toThrow(PublicationAccessDenied);
    await expect(approvePublicationDraft(db, read!, "draft", 0, admin)).rejects.toThrow(PublicationAccessDenied);
    await expect(createPublicationCorrection(db, read!, "release", "fix", admin)).rejects.toThrow(PublicationAccessDenied);
    const write = await resolvePrivilegedPublicationContext(db, admin, publicationId, "Perform approved support", "write");
    await expect(assertPublicationWrite(db, { ...write! }, "forged_write")).rejects.toThrow(PublicationAccessDenied);
    expect(() => authorizedPublicationFilter({ ...write! } as PublicationContext)).toThrow(PublicationAccessDenied);
    write!.id = "publication-two";
    await expect(assertPublicationWrite(db, write!, "cross_publication_write")).rejects.toThrow(PublicationAccessDenied);
  });

  it("records entry, each elevated write, exit and expiry; rejects stale, revoked and suspended authority", async () => {
    const support = await enterPublicationSupport(db, admin, publicationId, "Repair this publication's settings");
    const write = await resolvePrivilegedPublicationContext(db, admin, publicationId, "Change publication", "write");
    await assertPublicationWrite(db, write!, "first_mutation");
    await assertPublicationWrite(db, write!, "second_mutation");
    await db.collection("journalist_admins").updateOne({ principalId: admin.id }, { $set: { enabled: false } });
    await expect(assertPublicationWrite(db, write!, "disabled_mutation")).rejects.toThrow(PublicationAccessDenied);
    await db.collection("journalist_admins").updateOne({ principalId: admin.id }, { $set: { enabled: true } });
    await exitPublicationSupport(db, admin, publicationId);
    await expect(assertPublicationWrite(db, write!, "after_exit")).rejects.toThrow(PublicationAccessDenied);
    await enterPublicationSupport(db, admin, publicationId, "Continue investigating an unrelated issue");
    await db.collection("publication_support_sessions").updateMany({ ended_at: null }, { $set: { expires_at: Date.now() - 1 } });
    expect(await activePublicationSupport(db, admin, publicationId)).toBeNull();
    const events = await db.collection(COLLECTIONS.publicationAccessAudit).find().toArray();
    expect(events.map((event) => event.action)).toEqual([
      "support_entered", "privileged_write_access", "privileged_write_access", "support_exited", "support_entered", "support_expired",
    ]);
    expect(events.every((event) => publicationAccessAuditIsIntact(event as never))).toBe(true);
    expect(events.find((event) => event.action === "privileged_write_access")?.reason).toContain(support._id);
  });

  it("honors direct assigned rights without support or operator capabilities", async () => {
    const direct = await resolvePublicationContext(db, journalist.id, publicationId);
    await expect(assertPublicationWrite(db, direct!, "assigned_editorial_write")).resolves.toBeUndefined();
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(0);
    await expect(enterPublicationSupport(db, journalist, publicationId, "Attempt global support access")).rejects.toThrow(PublicationAccessDenied);
    await expect(resolvePrivilegedPublicationContext(db, journalist, "publication-two", "Attempt global inspection")).rejects.toThrow(PublicationAccessDenied);
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, { $set: { members: [] } });
    await expect(assertPublicationWrite(db, direct!, "removed_assignment")).rejects.toThrow(PublicationAccessDenied);
  });
});

describe("bounded workspace-owner audit", () => {
  it("verifies original historical account snapshots before projecting and detects signed-field tampering", async () => {
    const snapshot = {
      principalId: "historical-target", email: "historical@example.test", passwordStatus: "invited",
      providerSnapshot: { token: "SNAPSHOT-MUST-STAY-PRIVATE" },
      publicationIds: [publicationId], revision: 3, enabled: true, role: "editor" as const,
    };
    const actions = ["account_created", "invitation_created", "role_changed", "publication_assignments_changed"] as const;
    for (const [index, action] of actions.entries()) {
      const event = {
        _id: `historical-${index}`, actor_principal_id: owner.id, actor_email: owner.email, actor_role: "owner",
        target_principal_id: snapshot.principalId, target_email: snapshot.email, action,
        before: index === 0 ? null : snapshot, after: snapshot, at: 1000 + index,
      };
      const record_hash = createHash("sha256").update(JSON.stringify([
        event._id, event.actor_principal_id, event.actor_email, event.actor_role,
        event.target_principal_id, event.target_email, event.action, event.before, event.after, event.at,
      ])).digest("hex");
      await db.collection(COLLECTIONS.accessPolicyAudit).insertOne({ ...event, record_hash });
    }
    const page = await listGovernanceAudit(db, owner, { kind: "access_policy", limit: 3 });
    expect(page.records.map((record) => record.entryIntegrity)).toEqual([true, true, true]);
    expect(JSON.stringify(page)).not.toMatch(/SNAPSHOT-MUST-STAY-PRIVATE|passwordStatus|providerSnapshot/);
    expect(page.records[0]).toMatchObject({ after: { role: "editor", revision: 3, publicationIds: [publicationId] } });
    const last = await listGovernanceAudit(db, owner, { kind: "access_policy", limit: 3, cursor: page.nextCursor! });
    expect(last.records).toHaveLength(1);
    expect(last.records[0].entryIntegrity).toBe(true);
    await db.collection(COLLECTIONS.accessPolicyAudit).updateOne({ _id: "historical-3" }, { $set: { "after.passwordStatus": "tampered" } });
    const changed = await listGovernanceAudit(db, owner, { kind: "access_policy", limit: 1 });
    expect(changed.records[0].entryIntegrity).toBe(false);
    expect(changed.records[0].integrityStatus).toBe("mismatch");
    expect(JSON.stringify(changed)).not.toContain("tampered");
    await db.collection(COLLECTIONS.accessPolicyAudit).updateOne({ _id: "historical-3" }, { $unset: { record_hash: "" } });
    const legacy = await listGovernanceAudit(db, owner, { kind: "access_policy", limit: 1 });
    expect(legacy.records[0]).toMatchObject({ entryIntegrity: false, integrityStatus: "legacy_unknown" });
    expect(await db.collection(COLLECTIONS.accessPolicyAudit).findOne({ _id: "historical-3" })).not.toHaveProperty("record_hash");
  });

  it("combines access and change evidence using historical safe projections and bounded cursors without recursive read events", async () => {
    const immutable: Omit<AccessPolicyAuditEvent, "record_hash"> = {
      _id: "account-event", actor_principal_id: "deleted-actor", actor_email: "historical-actor@example.test", actor_role: "admin",
      target_principal_id: "deleted-target", target_email: "historical-target@example.test", action: "status_changed",
      before: { role: "editor", enabled: true, revision: 1, publicationIds: [publicationId] },
      after: { role: "editor", enabled: false, revision: 2, publicationIds: [publicationId] },
      at: Date.now() - 1000,
    };
    const record_hash = createHash("sha256").update(JSON.stringify([
      immutable._id, immutable.actor_principal_id, immutable.actor_email, immutable.actor_role,
      immutable.target_principal_id, immutable.target_email, immutable.action, immutable.before, immutable.after, immutable.at,
    ])).digest("hex");
    await db.collection(COLLECTIONS.accessPolicyAudit).insertOne({
      ...immutable, record_hash, passwordHash: "NEVER-EXPOSE", invitationToken: "NEVER-EXPOSE", providerSnapshot: "NEVER-EXPOSE",
    });
    await appendPublicationAccessAudit(db, {
      publication_id: publicationId, principal_id: admin.id, principal_email: admin.email,
      capability: "publication:inspect", action: "privileged_inspection", reason: "Historical publication inspection",
    });
    const ownership = await appendPublicationChangeAudit(db, {
      publication_id: publicationId, principal_id: owner.id, principal_email: owner.email, action: "ownership_transferred",
      resource_id: "successor", detail: "Deliberate ownership transfer", before_hash: "before", after_hash: "after",
      target_principal_id: "successor", target_email: "historical-successor@example.test",
      previous_owner_id: "former-owner", previous_owner_email: "historical-former@example.test", former_owner_membership: "remove",
    });
    expect(publicationAccessAuditIsIntact(ownership)).toBe(true);
    expect(publicationAccessAuditIsIntact({ ...ownership, previous_owner_email: "tampered@example.test" })).toBe(false);
    const count = await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments();
    const first = await listGovernanceAudit(db, owner, { limit: 2, publicationId });
    expect(first.records).toHaveLength(2);
    expect(first.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "publication", recordType: "access" }),
      expect.objectContaining({ kind: "publication", recordType: "change", previousOwner: { principalId: "former-owner", email: "historical-former@example.test" } }),
    ]));
    expect(first.nextCursor).toBeTruthy();
    const second = await listGovernanceAudit(db, owner, { limit: 1, publicationId, cursor: first.nextCursor! });
    expect(second.records).toMatchObject([{
      kind: "access_policy", actor: { email: immutable.actor_email }, target: { email: immutable.target_email }, entryIntegrity: true,
    }]);
    expect(JSON.stringify([first, second])).not.toContain("NEVER-EXPOSE");
    expect(second.records[0].at).toBe(immutable.at);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments()).toBe(count);
    expect(first.integrityScope).toBe("per_entry");
    await expect(listGovernanceAudit(db, admin)).rejects.toThrow(AccessPolicyError);
    await expect(listGovernanceAudit(db, journalist)).rejects.toThrow(AccessPolicyError);
    await expect(listGovernanceAudit(db, owner, { limit: 101 })).rejects.toThrow(AccessPolicyError);
    await expect(listGovernanceAudit(db, owner, { cursor: "malformed" })).rejects.toThrow(AccessPolicyError);
  });

  it("projects the real restore reader through the fenced database without exposing reserved stores or secret snapshots", async () => {
    const at = Date.now();
    await db.collection(RESTORE_EVIDENCE).insertMany(Array.from({ length: 25 }, (_, index) => ({
      action: "restore_failed_maintenance_closed", at: new Date(at + index), epoch: index, restoreId: `restore-${index}`,
      owner: { id: owner.id, email: owner.email, role: "owner", passwordHash: "NEVER-EXPOSE" },
      archiveHash: "a".repeat(64), governanceRollback: false, sourceCreatedAt: new Date(at).toISOString(),
      result: { collections: 1, documents: 10, artifactFiles: 2, credentials: "NEVER-EXPOSE" },
      collections: ["output_channels"], rawArchive: "NEVER-EXPOSE", detail: "Failure token=NEVER-EXPOSE",
    })));
    const fenced = await fencedDatabase(db);
    expect(() => fenced.collection(RESTORE_EVIDENCE)).toThrow(MaintenanceError);
    expect(() => fenced.collection(RESTORE_STATE)).toThrow(MaintenanceError);
    const evidence = await readRestoreEvidence(fenced);
    expect(evidence).toHaveLength(20);
    expect(evidence[0].at).toBeInstanceOf(Date);
    expect(evidence[0].epoch).toBe(24);
    const page = await listGovernanceAudit(fenced, owner);
    expect(page.restoreEvidence).toHaveLength(20);
    expect(page.restoreEvidence[0]).toMatchObject({ epoch: 24, atMilliseconds: at + 24 });
    expect(page.restoreEvidence.at(-1)?.epoch).toBe(5);
    expect(JSON.stringify(page.restoreEvidence)).not.toContain("NEVER-EXPOSE");
    await expect(listGovernanceAudit(fenced, admin)).rejects.toMatchObject({ status: 403 });
    await db.collection(RESTORE_EVIDENCE).deleteMany({});
    await db.collection(RESTORE_EVIDENCE).insertMany([
      { action: "maintenance_closed", at: new Date(at).toISOString() },
      { action: "invented_restore_success", at: new Date(at + 1), rawArchive: "NEVER-EXPOSE" },
    ]);
    const normalized = await listGovernanceAudit(fenced, owner);
    expect(normalized.restoreEvidence).toHaveLength(1);
    expect(normalized.restoreEvidence[0]).toMatchObject({ action: "maintenance_closed", atMilliseconds: at });
  });
});
