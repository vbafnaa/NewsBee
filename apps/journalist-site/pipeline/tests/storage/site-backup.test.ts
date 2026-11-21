import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BSON, MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSiteBackup, GOVERNANCE_CONFIRMATION, replaceSiteBackup, SITE_BACKUP_FORMAT, SITE_BACKUP_VERSION, validateSiteBackup } from "../../storage/site-backup";
import { DriveArtifacts } from "../../storage/drive";
import { BACKUP_STAGING_COLLECTIONS, deleteBackupUpload, readBackupUpload, saveBackupChunk, startBackupUpload } from "../../storage/site-backup-upload";
import { BACKUP_CHUNK_BYTES } from "../../../lib/site-backup-transfer";
import {
  enterMaintenance, fencedDatabase, maintenanceState, reopenMaintenance, RESTORE_EVIDENCE, RESTORE_STATE,
  withSiteWriter,
} from "../../../../../shared/restore-maintenance";
import { principalForSession } from "../../accounts/identity";
import { invitationDetails, passwordResetDetails, passwordSetupStatus } from "../../accounts/password-auth";
import { createHash } from "node:crypto";
import { fencedArtifacts, LocalArtifacts } from "../../storage/artifacts";

function archive(overrides: Record<string, unknown> = {}) {
  return {
    format: SITE_BACKUP_FORMAT,
    version: SITE_BACKUP_VERSION,
    createdAt: "2026-11-09T00:00:00.000Z",
    database: { collections: [{ name: "stories", documents: [BSON.EJSON.stringify({ _id: "story-1", createdAt: new Date(0) }, { relaxed: false })] }] },
    artifacts: { roots: [{ name: "reader-drive", files: [{ path: "edition.json", contentType: "application/json", data: Buffer.from("{}").toString("base64") }] }] },
    ...overrides,
  };
}

describe("site backup validation", () => {
  it("accepts a versioned archive with BSON documents and binary artifacts", () => {
    const result = validateSiteBackup(archive());
    const document = BSON.EJSON.parse(result.database.collections[0].documents[0], { relaxed: false });
    expect(document.createdAt).toEqual(new Date(0));
    expect(Buffer.from(result.artifacts.roots[0].files[0].data, "base64").toString()).toBe("{}");
  });

  it("validates a 10 MB artifact without overflowing the regular-expression stack", () => {
    const data = Buffer.alloc(10 * 1024 * 1024, 17).toString("base64");
    const input = archive({
      artifacts: { roots: [{ name: "reader-drive", files: [{ path: "video.mp4", contentType: "video/mp4", data }] }] },
    });
    expect(validateSiteBackup(input)).toBe(input);
  });

  it.each(["AAA\n", "a===", "AAAA=", "=AAA", "AA-A", "AAAA==", "AA", "A==="])("rejects malformed Base64 %j", (data) => {
    expect(() => validateSiteBackup(archive({
      artifacts: { roots: [{ name: "reader-drive", files: [{ path: "file.bin", contentType: "application/octet-stream", data }] }] },
    }))).toThrow("invalid artifact file");
  });

  describe("Reader channel backup and restore", () => {
    let server: MongoMemoryServer, client: MongoClient, db: Db, root: string;
    const channel = { _id: "reader-site", enabled: true, drive_folder_id: "channel-reader-root" };
    const owner = { id: "owner-id", email: "owner@example.test", role: "owner" };
    const restoreOptions = { owner, governanceConfirmation: GOVERNANCE_CONFIRMATION, expectedIdentityGeneration: "0" };
    async function closeMaintenance() {
      await db.collection("journalist_admins").updateOne({ email: owner.email }, {
        $set: { email: owner.email, principalId: owner.id, role: "owner", enabled: true },
      }, { upsert: true });
      await enterMaintenance(db, owner);
      restoreOptions.expectedIdentityGeneration = (await maintenanceState(db)).identityGeneration;
    }
    async function restore(backup: unknown) {
      await closeMaintenance();
      return replaceSiteBackup(db, backup, restoreOptions);
    }

    beforeAll(async () => {
      server = await MongoMemoryServer.create();
      client = await MongoClient.connect(server.getUri());
      db = client.db("reader-channel-backup");
    });
    beforeEach(async () => {
      await db.dropDatabase();
      const parent = path.resolve(".local");
      await mkdir(parent, { recursive: true });
      root = await mkdtemp(path.join(parent, "reader-backup-test-"));
      vi.stubEnv("NEWSBEE_MODE", "local");
      vi.stubEnv("NEWSBEE_OWNER_EMAIL", owner.email);
      vi.stubEnv("AUTH_SECRET", "isolated-restore-test-secret");
      vi.stubEnv("NEWSBEE_LOCAL_DRIVE_DIR", root);
      vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "fallback-folder");
      vi.stubEnv("NEWSBEE_OUTPUT_CHANNEL_ID", "reader-site");
      await mkdir(path.join(root, channel.drive_folder_id));
      await writeFile(path.join(root, channel.drive_folder_id, "edition.json"), '{"id":"channel-edition"}');
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    });
    afterAll(async () => { await client?.close(); await server?.stop(); });

    it("exports the channel folder and restores using the archived channel, not the current DB or fallback", async () => {
      const channels = db.collection<typeof channel>("output_channels");
      await channels.insertOne(channel);
      const backup = await createSiteBackup(db);
      const files = backup.artifacts.roots.find((item) => item.name === "reader-drive")!.files;
      expect(files.map((file) => file.path)).toEqual(["edition.json"]);
      expect(Buffer.from(files[0].data, "base64").toString()).toBe('{"id":"channel-edition"}');
      await channels.updateOne({ _id: channel._id }, { $set: { drive_folder_id: "different-live-folder" } });
      await restore(backup);
      expect(await readFile(path.join(root, channel.drive_folder_id, "edition.json"), "utf8"))
        .toBe('{"id":"channel-edition"}');
      expect(await channels.findOne({ _id: channel._id })).toMatchObject(channel);
    });

    it("exports the fallback folder only when the channel is absent", async () => {
      await mkdir(path.join(root, "fallback-folder"));
      await writeFile(path.join(root, "fallback-folder", "fallback.json"), "{}");
      const backup = await createSiteBackup(db);
      expect(backup.artifacts.roots.find((item) => item.name === "reader-drive")!.files.map((file) => file.path))
        .toEqual(["fallback.json"]);
    });

    it("rejects disabled live and archived channels before changing files or collections", async () => {
      await db.collection<typeof channel>("output_channels").insertOne({ ...channel, enabled: false });
      await expect(createSiteBackup(db)).rejects.toThrow("disabled");
      const backup = archive({
        database: { collections: [{
          name: "output_channels", documents: [BSON.EJSON.stringify({ ...channel, enabled: false })],
        }] },
      });
      await closeMaintenance();
      await expect(replaceSiteBackup(db, backup, restoreOptions)).rejects.toThrow("disabled");
      expect(await readFile(path.join(root, channel.drive_folder_id, "edition.json"), "utf8"))
        .toBe('{"id":"channel-edition"}');
      expect(await db.collection("output_channels").countDocuments()).toBe(1);
    });

    it("round-trips an upload larger than Vercel's request limit in bounded, ordered chunks", async () => {
      const owner = "editor@example.test";
      const value = { text: "backup-data ".repeat(600_000) };
      const bytes = Buffer.from(JSON.stringify(value));
      const { uploadId } = await startBackupUpload(db, owner, bytes.length);
      await expect(readBackupUpload(db, owner, uploadId)).rejects.toThrow("incomplete");
      for (let offset = 0, part = 0; offset < bytes.length; offset += BACKUP_CHUNK_BYTES, part += 1) {
        await saveBackupChunk(db, owner, uploadId, part, bytes.subarray(offset, offset + BACKUP_CHUNK_BYTES));
      }
      await expect(readBackupUpload(db, "another@example.test", uploadId)).rejects.toThrow("not found");
      await expect(readBackupUpload(db, owner, uploadId)).resolves.toEqual(value);
      await deleteBackupUpload(db, owner, uploadId);
      expect(await db.collection(BACKUP_STAGING_COLLECTIONS[1]).countDocuments()).toBe(0);
    });

    it("rejects malformed or expired upload chunks without touching site data", async () => {
      const owner = "editor@example.test";
      const { uploadId } = await startBackupUpload(db, owner, 2);
      await expect(saveBackupChunk(db, owner, uploadId, 0, Buffer.from("x"))).rejects.toThrow("chunk size");
      await expect(saveBackupChunk(db, owner, uploadId, -1, Buffer.from("{}"))).rejects.toThrow("position");
      await db.collection<{ _id: string; expiresAt: Date }>(BACKUP_STAGING_COLLECTIONS[0])
        .updateOne({ _id: uploadId }, { $set: { expiresAt: new Date(0) } });
      await expect(saveBackupChunk(db, owner, uploadId, 0, Buffer.from("{}"))).rejects.toThrow("expired");
      expect(await readFile(path.join(root, channel.drive_folder_id, "edition.json"), "utf8"))
        .toBe('{"id":"channel-edition"}');
    });

    it("excludes temporary uploads from archives and preserves them during restore", async () => {
      await db.collection<typeof channel>("output_channels").insertOne(channel);
      const { uploadId } = await startBackupUpload(db, "editor@example.test", 2);
      await saveBackupChunk(db, "editor@example.test", uploadId, 0, Buffer.from("{}"));
      const backup = await createSiteBackup(db);
      expect(backup.database.collections.map((item) => item.name)).toEqual(["output_channels"]);
      await restore(backup);
      await expect(readBackupUpload(db, "editor@example.test", uploadId)).resolves.toEqual({});
    });

    it("exports nested Drive files concurrently within the transfer limit and reports progress", async () => {
      vi.stubEnv("NEWSBEE_MODE", "cloud");
      vi.stubEnv("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID", "pipeline-root-id");
      const entries = Array.from({ length: 18 }, (_, i) => ({ id: `file-id-${i}`, name: `file-${i}.json`, mimeType: "application/json" }));
      vi.spyOn(DriveArtifacts.prototype, "listEntries").mockImplementation(async (id) =>
        id === "fallback-folder" ? [{ id: "nested-root-id", name: "nested", mimeType: "application/vnd.google-apps.folder" }]
          : id === "nested-root-id" ? entries : []);
      let active = 0;
      let maximum = 0;
      vi.spyOn(DriveArtifacts.prototype, "readBinary").mockImplementation(async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return Buffer.from("{}");
      });
      const onProgress = vi.fn();
      const backup = await createSiteBackup(db, { onProgress });
      expect(backup.artifacts.roots[0].files).toHaveLength(18);
      expect(backup.artifacts.roots[0].files.every((file) => file.path.startsWith("nested/"))).toBe(true);
      expect(maximum).toBeGreaterThan(1);
      expect(maximum).toBeLessThanOrEqual(6);
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining("18 artifact"));
    });

    it("does not start replacement after cancellation", async () => {
      const backup = await createSiteBackup(db);
      const controller = new AbortController();
      controller.abort(new Error("Transfer cancelled"));
      await expect(replaceSiteBackup(db, backup, { signal: controller.signal })).rejects.toThrow("Transfer cancelled");
      expect(await readFile(path.join(root, channel.drive_folder_id, "edition.json"), "utf8"))
        .toBe('{"id":"channel-edition"}');
    });

    it("rejects missing owner/governance, open maintenance and reserved-store injection without destruction", async () => {
      const backup = await createSiteBackup(db);
      await expect(replaceSiteBackup(db, backup)).rejects.toThrow("Explicit owner");
      await expect(replaceSiteBackup(db, backup, { owner })).rejects.toThrow("governance");
      await db.collection("journalist_admins").insertOne({ email: owner.email, principalId: owner.id, enabled: true });
      await expect(replaceSiteBackup(db, backup, restoreOptions)).rejects.toThrow("Close maintenance");
      for (const name of [RESTORE_STATE, RESTORE_EVIDENCE, "_newsbee_restore_injected", ...BACKUP_STAGING_COLLECTIONS]) {
        await expect(replaceSiteBackup(db, {
          ...backup, database: { collections: [{ name, documents: [] }] },
        }, restoreOptions)).rejects.toThrow("invalid collection");
      }
      expect(await readFile(path.join(root, channel.drive_folder_id, "edition.json"), "utf8"))
        .toBe('{"id":"channel-edition"}');
    });

    it("serializes maintenance with actual writers and fences stale DB/artifact handles after reopening", async () => {
      const backup = await createSiteBackup(db);
      const handle = await fencedDatabase(db);
      const artifacts = fencedArtifacts(new LocalArtifacts(root), handle);
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const writer = withSiteWriter(handle, async () => {
        entered();
        await blocked;
        // An admitted writer may finish while admission is closed, and remains counted.
        await handle.collection("stories").insertOne({ value: "drained" });
      });
      await started;
      await closeMaintenance();
      expect(await principalForSession(db, owner.id, 0, "0")).toBeNull();
      await expect(handle.collection("stories").insertOne({ value: "new" })).rejects.toThrow("maintenance");
      await expect(artifacts.saveText("pipeline", "blocked.txt", "no", "text/plain")).rejects.toThrow("maintenance");
      await expect(replaceSiteBackup(db, backup, restoreOptions)).rejects.toThrow("drain");
      release();
      await writer;
      await replaceSiteBackup(db, backup, restoreOptions);
      await reopenMaintenance(db, owner);
      await expect(handle.collection("stories").insertOne({ value: "obsolete" })).rejects.toThrow("obsolete");
      const fresh = await fencedDatabase(db);
      await fresh.collection("stories").insertOne({ value: "fresh" });
    });

    it("rejects concurrent restore and retains start/completion evidence outside the replacement", async () => {
      const backup = await createSiteBackup(db);
      await closeMaintenance();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      // Delay the first destructive database step, after artifact replacement has started.
      const original = db.listCollections.bind(db);
      const spy = vi.spyOn(db, "listCollections").mockImplementation((...args) => {
        const cursor = original(...args);
        const toArray = cursor.toArray.bind(cursor);
        cursor.toArray = async () => { await blocked; return toArray(); };
        return cursor;
      });
      const running = replaceSiteBackup(db, backup, restoreOptions);
      while ((await maintenanceState(db)).phase !== "restoring") await new Promise((resolve) => setTimeout(resolve, 1));
      await expect(replaceSiteBackup(db, backup, restoreOptions)).rejects.toThrow("concurrent");
      release();
      await running;
      spy.mockRestore();
      const state = await maintenanceState(db);
      expect(state.phase).toBe("restored");
      await expect(replaceSiteBackup(db, backup, restoreOptions)).rejects.toThrow("authorization is obsolete");
      expect(await db.collection(RESTORE_EVIDENCE).countDocuments({ restoreId: state.restoreId })).toBe(2);
      const exported = await createSiteBackup(db);
      expect(exported.database.collections.some(({ name }) => name.startsWith("_newsbee_restore_"))).toBe(false);
    });

    it("keeps a failed parallel operation counted until its still-writing siblings settle", async () => {
      const backup = await createSiteBackup(db);
      const handle = await fencedDatabase(db);
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const writer = withSiteWriter(handle, async () => Promise.all([
        withSiteWriter(handle, async () => { throw new Error("parallel failure"); }),
        withSiteWriter(handle, async () => {
          entered();
          await blocked;
          await handle.collection("stories").insertOne({ value: "last sibling" });
        }),
      ])).catch((error: unknown) => error);
      await started;
      await closeMaintenance();
      expect((await maintenanceState(db)).writers).toHaveLength(1);
      await expect(replaceSiteBackup(db, backup, restoreOptions)).rejects.toThrow("drain");
      release();
      expect(await writer).toMatchObject({ message: "parallel failure" });
      expect((await maintenanceState(db)).writers).toHaveLength(0);
      expect(await db.collection("stories").findOne({ value: "last sibling" })).toBeTruthy();
    });

    it("does not let an obsolete asynchronous continuation reacquire fresh authority after reopening", async () => {
      const backup = await createSiteBackup(db);
      const handle = await fencedDatabase(db);
      let release!: () => void;
      let late!: Promise<unknown>;
      await withSiteWriter(handle, async () => {
        late = new Promise<void>((resolve) => { release = resolve; }).then(async () => {
          const reacquired = await fencedDatabase(client.db(db.databaseName));
          await reacquired.collection("stories").insertOne({ value: "obsolete continuation" });
        });
      });
      await closeMaintenance();
      await replaceSiteBackup(db, backup, restoreOptions);
      await reopenMaintenance(db, owner);
      release();
      await expect(late).rejects.toThrow("obsolete");
      expect(await db.collection("stories").countDocuments({ value: "obsolete continuation" })).toBe(0);
    });

    it.each(["error", "abort"])("keeps a partial %s closed, records truthful evidence, and permits only known-good recovery", async (failure) => {
      const backup = await createSiteBackup(db);
      await closeMaintenance();
      const controller = new AbortController();
      await expect(replaceSiteBackup(db, backup, {
        ...restoreOptions,
        signal: controller.signal,
        onProgress: (message) => {
          if (message !== "Replacing database collections...") return;
          if (failure === "abort") {
            controller.abort(new Error("Injected partial failure"));
            controller.signal.throwIfAborted();
          }
          throw new Error("Injected partial failure");
        },
      })).rejects.toThrow("Injected partial failure");
      expect(await maintenanceState(db)).toMatchObject({ phase: "failed", error: "Injected partial failure" });
      await expect(reopenMaintenance(db, owner)).rejects.toThrow("Cannot reopen");
      const handle = await fencedDatabase(db);
      await expect(handle.collection("stories").insertOne({ value: "closed" })).rejects.toThrow("maintenance");
      expect(await db.collection(RESTORE_EVIDENCE).countDocuments({ action: "restore_failed_maintenance_closed" })).toBe(1);
      restoreOptions.expectedIdentityGeneration = (await maintenanceState(db)).identityGeneration;
      await replaceSiteBackup(db, backup, restoreOptions);
      expect((await maintenanceState(db)).phase).toBe("restored");
      expect(await db.collection(RESTORE_EVIDENCE).countDocuments({ action: "restore_started" })).toBe(2);
    });

    it("does not delete artifacts when independent evidence cannot be retained", async () => {
      const backup = await createSiteBackup(db);
      await closeMaintenance();
      const evidence = db.collection(RESTORE_EVIDENCE);
      vi.spyOn(evidence, "insertOne").mockRejectedValue(new Error("Independent evidence unavailable"));
      const collection = db.collection.bind(db);
      vi.spyOn(db, "collection").mockImplementation((name, ...args) =>
        name === RESTORE_EVIDENCE ? evidence : collection(name, ...args));
      await expect(replaceSiteBackup(db, backup, restoreOptions)).rejects.toThrow("Independent evidence unavailable");
      expect((await maintenanceState(db)).phase).toBe("failed");
      expect(await readFile(path.join(root, channel.drive_folder_id, "edition.json"), "utf8"))
        .toBe('{"id":"channel-edition"}');
    });

    it("allows a known-good retry when a partial restore copied obsolete running jobs", async () => {
      const backup = await createSiteBackup(db);
      await closeMaintenance();
      const failed = {
        ...backup, database: { collections: [
          { name: "pipeline_jobs", documents: [BSON.EJSON.stringify({ status: "running", claim_token: "snapshot-only" })] },
          { name: "next_collection", documents: [] },
        ] },
      };
      await expect(replaceSiteBackup(db, failed, {
        ...restoreOptions, onProgress: (message) => {
          if (message === "Restoring database collection: next_collection") throw new Error("Interrupted after copying job state");
        },
      })).rejects.toThrow("Interrupted");
      expect(await db.collection("pipeline_jobs").countDocuments({ status: "running" })).toBe(1);
      restoreOptions.expectedIdentityGeneration = (await maintenanceState(db)).identityGeneration;
      await replaceSiteBackup(db, backup, restoreOptions);
      expect((await maintenanceState(db)).phase).toBe("restored");
    });

    it("revokes rolled-back sessions and setup/recovery links and quarantines restored worker authority", async () => {
      const token = "a".repeat(43);
      const hash = createHash("sha256").update(token).digest("hex");
      const editorAccount = {
        email: "editor@example.test", principalId: "editor-id", enabled: true, sessionVersion: 0,
        passwordSetupExpiresAt: new Date(Date.now() + 60_000),
      };
      await db.collection("journalist_admins").insertOne(editorAccount);
      await db.collection("journalist_account_invitations").insertOne({
        token_hash: hash, principal_id: "editor-id", email: "editor@example.test", used_at: null, expires_at: new Date(Date.now() + 60_000),
      });
      await db.collection("journalist_password_resets").insertOne({
        token_hash: hash, principal_id: "editor-id", session_version: 0, used_at: null, expires_at: new Date(Date.now() + 60_000),
      });
      await db.collection("pipeline_jobs").insertOne({ status: "running", claim_token: "archived-authority", lease_until: 1 });
      const backup = await createSiteBackup(db);
      await db.collection("pipeline_jobs").deleteMany({});
      await restore(backup);
      const generation = (await maintenanceState(db)).identityGeneration;
      expect(generation).not.toBe("0");
      // Configured-owner recovery survives even when the archive has no owner collection row.
      expect(await principalForSession(db, owner.id, 0, generation)).toEqual(owner);
      await reopenMaintenance(db, owner);
      expect(await principalForSession(db, "editor-id", 0)).toBeNull();
      expect(await principalForSession(db, "editor-id", 0, generation)).toMatchObject({ id: "editor-id" });
      await expect(invitationDetails(db, token)).rejects.toThrow("invalid or expired");
      await expect(passwordResetDetails(db, token, new Request("https://fixture.test"))).rejects.toThrow("invalid or expired");
      expect(await passwordSetupStatus(db, editorAccount)).toEqual({ passwordStatus: "expired", recoveryStatus: null });
      expect(await db.collection("pipeline_jobs").findOne({ claim_token: "archived-authority" })).toBeNull();
      expect(await db.collection("pipeline_jobs").findOne({ status: "cancelled" })).toBeTruthy();
      expect(await db.collection("pipeline_jobs").findOne({ status: "cancelled" }))
        .toMatchObject({ restore_quarantine: { status: "running", claim_token: "archived-authority" } });
    });

    it("does not assume expired or untracked worker leases are drained", async () => {
      const backup = await createSiteBackup(db);
      await closeMaintenance();
      await db.collection("pipeline_jobs").insertOne({ status: "running", lease_until: 0 });
      await expect(replaceSiteBackup(db, backup, restoreOptions)).rejects.toThrow("pipeline_jobs");
      expect((await maintenanceState(db)).phase).toBe("draining");
      expect(await readFile(path.join(root, channel.drive_folder_id, "edition.json"), "utf8"))
        .toBe('{"id":"channel-edition"}');
    });
  });

  it("rejects unsupported versions and malformed BSON before import", () => {
    expect(() => validateSiteBackup(archive({ version: 2 }))).toThrow("Unsupported backup");
    expect(() => validateSiteBackup(archive({
      database: { collections: [{ name: "stories", documents: ["not-json"] }] },
    }))).toThrow("invalid BSON document");
  });

  it("rejects unsafe and duplicate artifact paths", () => {
    expect(() => validateSiteBackup(archive({
      artifacts: { roots: [{ name: "reader-drive", files: [{ path: "../outside", contentType: "text/plain", data: "" }] }] },
    }))).toThrow("unsafe artifact path");
    expect(() => validateSiteBackup(archive({
      artifacts: { roots: [{ name: "reader-drive", files: [
        { path: "same.json", contentType: "application/json", data: "" },
        { path: "same.json", contentType: "application/json", data: "" },
      ] }] },
    }))).toThrow("duplicate artifact path");
  });
});
