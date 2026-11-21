import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { expect, it, vi } from "vitest";
import { resolvePublicationContext } from "../../publications/access";
import { loadPublicationReleaseForDistribution } from "../../publications/releases";
import { publicationDraftPreview, publicationEditorialWorkspace } from "../../publications/editorial";
import type { PublicationDraft } from "../../publications/generation";
import { locationReadinessForIds } from "../../communities/readiness";
import { ensureRunIndexes, recentRuns, runs } from "../../orchestration/runs";
import {
  loadReaderPublication,
  publicationDirectory,
  readerData,
} from "../../../../reader-site/src/lib/reader-data";

const site = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);

it("reaches the local access seed from the stack startup path", () => {
  const result = spawnSync(process.execPath, ["scripts/local-stack.mjs"], {
    cwd: site,
    env: {
      ...process.env,
      MONGODB_URI:
        "mongodb://127.0.0.1:1/?directConnection=true&serverSelectionTimeoutMS=50",
      MONGODB_DATABASE: "newsbee-local-stack-scope-test",
    },
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("[local-stack] Using MONGODB_URI from the environment");
  expect(result.stderr).toContain("MongoServerSelectionError");
  expect(result.stderr).not.toContain("ReferenceError");
});

it("refuses remote MongoDB before writing review data", () => {
  const result = spawnSync(process.execPath, ["scripts/local-stack.mjs"], {
    cwd: site,
    env: { ...process.env, MONGODB_URI: "mongodb://remote.example.test/newsbee" },
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("remote databases are not allowed");
});

it("seeds Reader locations and publication artifacts", async () => {
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const driveRoot = mkdtempSync(path.join(tmpdir(), "newsbee-local-stack-"));
  const databaseName = "newsbee-local-stack-reader-test";
  try {
    const result = await execFileAsync(process.execPath, ["scripts/local-stack.mjs"], {
      cwd: site,
      env: {
        ...process.env,
        MONGODB_URI: server.getUri(),
        MONGODB_DATABASE: databaseName,
        NEWSBEE_LOCAL_DRIVE_DIR: driveRoot,
        NEWSBEE_READER_DRIVE_FOLDER_ID: "newsbee-test-reader",
        NEWSBEE_LOCAL_SEED_ONLY: "1",
      },
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });

    expect(result.stdout).toContain("Seeded local accounts, publications, campaign leads, and Reader catalog");
    const locations = JSON.parse(readFileSync(
      path.join(driveRoot, "newsbee-test-reader", "locations.json"),
      "utf8",
    ));
    expect(locations).toEqual({
      locations: [
        { id: "northside-wa", name: "Northside, WA" },
        { id: "harbor-wa", name: "Harbor, WA" },
      ],
    });

    const client = await MongoClient.connect(server.getUri());
    try {
      const db = client.db(databaseName);
      const publications = await db.collection("output_channels").find({
        _id: { $in: ["a".repeat(32), "b".repeat(32)] },
      }).sort({ _id: 1 }).toArray();
      expect(publications).toHaveLength(2);
      expect(publications.map((publication) => publication.reader_publication?.location_ids)).toEqual([
        ["northside-wa"],
        ["harbor-wa"],
      ]);
      expect(await db.collection("output_channel_files").countDocuments()).toBe(6);
      const publishedDrafts = await db.collection("publication_drafts").find({
        publication_id: { $in: ["a".repeat(32), "b".repeat(32)] },
        editorial_status: "published",
      }).sort({ publication_id: 1 }).toArray();
      expect(publishedDrafts).toHaveLength(3);
      expect(new Set(publishedDrafts.map((draft) => draft.generation_id)).size).toBe(3);
      const publicationContext = await resolvePublicationContext(db, "local-admin", "a".repeat(32));
      expect(publicationContext).not.toBeNull();
      expect((await loadPublicationReleaseForDistribution(
        db,
        publicationContext!,
        publishedDrafts.find((draft) => draft._id === "local-draft-1")!.release.release_id,
      )).payload.items[0]?.item_id).toBe("local-story-1");
      const drafts = await db.collection<PublicationDraft>("publication_drafts").find({}).toArray();
      expect(drafts).toHaveLength(5);
      expect(drafts.filter((draft) => draft.unpublished).map((draft) => draft.editorial_status).sort())
        .toEqual(["approved", "editing"]);
      for (const draft of drafts) {
        const context = (await resolvePublicationContext(db, "local-admin", draft.publication_id))!;
        // Exercise the exact production read that used to throw on stories.flatMap.
        const workspace = (await publicationEditorialWorkspace(db, context, draft._id))!;
        expect(workspace.draft.stories).toHaveLength(1);
        expect(workspace.evidence[0].sources).toHaveLength(1);
        expect(workspace.evidence[0].items[0].title).toBe(draft.stories[0].snapshot.headline);
        expect(workspace.images.some((image) =>
          image._id === workspace.draft.presentation.stories[0].image_id)).toBe(true);
        const preview = publicationDraftPreview(workspace.draft, workspace.images);
        expect(preview.sections[0].stories[0].image?.image_alt).toBe("Illustrated community notice board");
        expect(draft.window).toEqual(["2026-11-09", "2026-11-15"]);
        expect(draft.locations[0].source_map_version).toBe(1);
        if (draft.release) {
          expect(draft.release.published_at).toBeGreaterThan(Date.parse("2026-11-15T00:00:00Z") / 1000);
          expect(draft.distribution).toEqual({ reader: true, email: false });
        }
      }
      const editing = drafts.find((draft) => draft._id === "local-unpublished-1")!;
      expect(editing.presentation.stories.find((story) => story.origin === "original")?.source_metadata[0].type).toBe("web");
      const readiness = await locationReadinessForIds(db, locations.locations);
      expect(readiness.every((location) => location.onboarded && location.ready && location.active_source_count > 0)).toBe(true);
      expect(await resolvePublicationContext(db, "local-editor-a", "b".repeat(32))).toBeNull();
      expect(await resolvePublicationContext(db, "local-editor-b", "a".repeat(32))).toBeNull();
      expect((await resolvePublicationContext(db, "local-editor-a", "a".repeat(32)))?.role).toBe("editor");
      expect((await resolvePublicationContext(db, "local-editor-b", "b".repeat(32)))?.role).toBe("editor");
      expect((await db.collection("journalist_admins").find().toArray()).map((account) => account.role).sort())
        .toEqual(["admin", "editor", "editor", "owner"]);
      await ensureRunIndexes(db);
      expect((await runs(db).findOne({ _id: "local-source-run-a" }))?.status).toBe("mapping");
      expect((await runs(db).findOne({ _id: "local-source-run-b" }))?.status).toBe("mapped");
      const recent = await recentRuns(db, { locationId: "harbor-wa", limit: 200 });
      expect(recent).toHaveLength(200);
      expect(recent.some((run) => run._id === "local-old-run")).toBe(false);
      expect(await runs(db).findOne({ _id: "local-old-run" })).not.toBeNull();
      const blocked = await db.collection("publication_generations").findOne({ _id: "local-blocked-generation" });
      expect(blocked?.status).toBe("failed");
      expect(blocked?.error).toContain("no credential sponsor");
      expect((await runs(db).findOne({ _id: blocked?.child_run_ids[0] }))?.publication_generation_id).toBe(blocked?._id);
      expect(await db.collection("pipeline_jobs").countDocuments()).toBe(0);
      expect(await db.collection("publication_email_outbox").countDocuments()).toBe(0);
      await db.collection<PublicationDraft>("publication_drafts").updateOne({ _id: editing._id }, {
        $set: { "presentation.headline": "Preserve my local review edit" },
      });
      for (const scenario of ["source-runs", "blocked-generation", "source-runs"]) {
        await execFileAsync(process.execPath, ["scripts/local-stack.mjs"], {
          cwd: site,
          env: {
            ...process.env, MONGODB_URI: server.getUri(), MONGODB_DATABASE: databaseName,
            NEWSBEE_LOCAL_DRIVE_DIR: driveRoot, NEWSBEE_READER_DRIVE_FOLDER_ID: "newsbee-test-reader",
            NEWSBEE_LOCAL_SEED_ONLY: "1", NEWSBEE_LOCAL_REVIEW_SCENARIO: scenario,
          },
          encoding: "utf8", timeout: 20_000, windowsHide: true,
        });
        await ensureRunIndexes(db);
        const active = await runs(db).find({ status: { $in: ["mapping", "collecting"] } }).toArray();
        expect(active.map((run) => run._id)).toEqual([
          scenario === "blocked-generation" ? "local-blocked-child" : "local-source-run-a",
        ]);
        expect(active[0].execution_blocked).toBeDefined();
        expect((await db.collection("publication_generations").findOne({ _id: "local-blocked-generation" }))?.status)
          .toBe(scenario === "blocked-generation" ? "blocked" : "failed");
        expect(await db.collection("publication_drafts").countDocuments()).toBe(5);
        expect(await db.collection("output_channel_files").countDocuments()).toBe(6);
        expect((await db.collection<PublicationDraft>("publication_drafts").findOne({ _id: editing._id }))?.presentation.headline)
          .toBe("Preserve my local review edit");
      }
      const campaignLeads = await db.collection("campaign_signups").find().toArray();
      expect(campaignLeads).toHaveLength(72);
      expect(new Set(campaignLeads.map((lead) => lead.campaign))).toEqual(new Set([
        "newsroom",
        "college-journalism",
        "high-school-journalism",
        "branded-news",
      ]));
      const firstLead = campaignLeads.find((lead) => lead.email === "campaign-1@example.test");
      expect(firstLead?._id).toBe(createHash("sha256")
        .update("newsroom:campaign-1@example.test")
        .digest("hex"));
      expect(campaignLeads.some((lead) => Date.now() - lead.createdAt.getTime() < 7 * 24 * 60 * 60 * 1000)).toBe(true);
      expect(campaignLeads.some((lead) => Date.now() - lead.createdAt.getTime() > 7 * 24 * 60 * 60 * 1000)).toBe(true);
      vi.stubEnv("MONGODB_URI", server.getUri());
      vi.stubEnv("MONGODB_DATABASE", databaseName);
      vi.stubEnv("NEWSBEE_MODE", "local");
      vi.stubEnv("NEWSBEE_LOCAL_DRIVE_DIR", driveRoot);
      vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "newsbee-test-reader");
      delete (globalThis as typeof globalThis & { newsbeeReaderData?: unknown }).newsbeeReaderData;

      expect((await readerData()).locations).toEqual(locations.locations);
      expect((await publicationDirectory(undefined, db)).map((publication) => publication.display_name))
        .toEqual(["Harbor Daily", "Northside Weekly"]);
      expect((await loadReaderPublication("a".repeat(32), undefined, db))?.release.items[0]?.headline)
        .toBe("Library expands weekend programs");
    } finally {
      vi.unstubAllEnvs();
      await client.close();
    }
  } finally {
    await server.stop();
    rmSync(driveRoot, { recursive: true, force: true });
  }
}, 90_000);
