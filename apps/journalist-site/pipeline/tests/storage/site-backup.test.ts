import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BSON, MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSiteBackup, replaceSiteBackup, SITE_BACKUP_FORMAT, SITE_BACKUP_VERSION, validateSiteBackup } from "../../storage/site-backup";

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

  describe("Reader channel backup and restore", () => {
    let server: MongoMemoryServer, client: MongoClient, db: Db, root: string;
    const channel = { _id: "reader-site", enabled: true, drive_folder_id: "channel-reader-root" };

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
      vi.stubEnv("NEWSBEE_LOCAL_DRIVE_DIR", root);
      vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "fallback-folder");
      vi.stubEnv("NEWSBEE_OUTPUT_CHANNEL_ID", "reader-site");
      await mkdir(path.join(root, channel.drive_folder_id));
      await writeFile(path.join(root, channel.drive_folder_id, "edition.json"), '{"id":"channel-edition"}');
    });
    afterEach(async () => {
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
      await replaceSiteBackup(db, backup);
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
      await expect(replaceSiteBackup(db, backup)).rejects.toThrow("disabled");
      expect(await readFile(path.join(root, channel.drive_folder_id, "edition.json"), "utf8"))
        .toBe('{"id":"channel-edition"}');
      expect(await db.collection("output_channels").countDocuments()).toBe(1);
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
