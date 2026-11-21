import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { parseEdition } from "../../../../reader-site/src/lib/reader-data";
import type { Principal } from "../../accounts/identity";
import {
  createOutputChannel,
  outputChannels,
  resolveOutputChannel,
  resolveOutputChannelForPrincipal,
} from "../../orchestration/output-channels";
import { publishToReader } from "../../orchestration/publish";
import {
  publicationAccessAuditIsIntact,
  type PublicationAccessAuditEvent,
  type PublicationChangeAuditEvent,
} from "../../publications/audit";
import {
  getPublicationSettings,
  PublicationSettingsConflict,
  PublicationSettingsValidationError,
  updatePublicationSettings,
} from "../../publications/settings";
import type { ArtifactStore } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { enterPublicationSupport } from "../../publications/support";

const publicationId = "a".repeat(32);
const owner: Principal = { id: "owner", email: "owner@example.test", role: "owner" };
let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let saved: Array<{ folder: string; name: string; value: unknown }>;
const store: ArtifactStore = {
  kind: "local",
  ensureFolder: async () => "folder",
  saveText: async () => "file",
  saveJson: async (folder, name, value) => { saved.push({ folder, name, value }); return name; },
  readText: async () => "",
  readJson: async <T>() => ({} as T),
  list: async () => [],
  findFolder: async () => null,
  removeFile: async () => 0,
};

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-settings");
});
beforeEach(async () => {
  await db.dropDatabase();
  saved = [];
  await db.collection(COLLECTIONS.locations).insertOne({ _id: "town-wa", id: "town-wa", name: "Town, WA", state: "WA", systems: [] });
  await createOutputChannel(db, owner.id, publicationId, "reader-folder", {
    name: "Town Independent",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: ["town-wa"],
  });
});
afterAll(async () => { await client.close(); await server.stop(); });

describe("versioned publication settings", () => {
  it("supports audited settings reads and writes for an unassigned admin", async () => {
    const admin: Principal = { id: "support-admin", email: "support-admin@example.test", role: "admin" };
    await db.collection("journalist_admins").insertOne({ principalId: admin.id, email: admin.email, role: "admin", enabled: true });
    const readAccess = (await resolveOutputChannelForPrincipal(
      db,
      admin,
      publicationId,
      "Review publication settings in the support workspace",
    ))!;
    expect(await getPublicationSettings(db, readAccess.context)).toMatchObject({
      profile: { revision: 0, values: { display_name: "Town Independent" } },
    });

    await enterPublicationSupport(db, admin, publicationId, "Resolve the reported publication profile issue");
    const writeAccess = (await resolveOutputChannelForPrincipal(
      db,
      admin,
      publicationId,
      "Update publication settings from the support workspace",
      "write",
    ))!;
    await expect(updatePublicationSettings(db, writeAccess.context, admin, {
      profile: {
        expected_revision: 0,
        values: {
          display_name: "Town Support Update",
          description: null,
          homepage_url: null,
          logo_url: null,
        },
      },
    })).resolves.toMatchObject({
      profile: { revision: 1, values: { display_name: "Town Support Update" } },
    });
    const events = await db.collection<PublicationAccessAuditEvent | PublicationChangeAuditEvent>(
      COLLECTIONS.publicationAccessAudit,
    ).find().toArray();
    expect(events).toHaveLength(4);
    expect(events.every(publicationAccessAuditIsIntact)).toBe(true);
  });

  it("uses legacy defaults, validates images only on save, writes CAS revisions, and appends intact audit events", async () => {
    const access = (await resolveOutputChannel(db, owner.id, publicationId))!;
    expect(await getPublicationSettings(db, access.context)).toMatchObject({
      profile: { revision: 0, values: { display_name: "Town Independent" } },
      generation_preferences: { revision: 0, values: { voice: "neutral", story_length: "standard" } },
      sponsor_placements: { revision: 0, values: [] },
    });
    const validateImage = vi.fn(async () => ({ hash: "fixture" }));
    const settings = await updatePublicationSettings(db, access.context, owner, {
      profile: {
        expected_revision: 0,
        values: {
          display_name: "Town News",
          description: "Independent local reporting.",
          homepage_url: "https://town.example/",
          logo_url: "https://images.example/logo.png",
        },
      },
      generation_preferences: {
        expected_revision: 0,
        values: { voice: "warm", story_length: "brief", front_summary_density: "compact", newsletter_intro_length: "brief" },
      },
      sponsor_placements: {
        expected_revision: 0,
        values: [{
          id: "home-after",
          slot: "home_after_top_news",
          sponsor_name: "Town Books",
          headline: "Local books, locally stocked",
          body: "Browse this week's neighborhood picks.",
          landing_url: "https://sponsor.example/books",
          image_url: "https://images.example/books.png",
          enabled: true,
        }],
      },
    }, validateImage);
    expect(validateImage.mock.calls.map(([url]) => url)).toEqual([
      "https://images.example/logo.png",
      "https://images.example/books.png",
    ]);
    expect(settings).toMatchObject({
      profile: { revision: 1 },
      generation_preferences: { revision: 1, values: { voice: "warm" } },
      sponsor_placements: { revision: 1, values: [{ slot: "home_after_top_news" }] },
    });
    const audit = await db.collection<PublicationChangeAuditEvent>(COLLECTIONS.publicationAccessAudit).find().toArray();
    expect(audit).toHaveLength(3);
    expect(audit.every(publicationAccessAuditIsIntact)).toBe(true);
    await expect(updatePublicationSettings(db, access.context, owner, {
      profile: { expected_revision: 0, values: settings!.profile.values },
    }, validateImage)).rejects.toBeInstanceOf(PublicationSettingsConflict);
    await expect(updatePublicationSettings(db, access.context, owner, {
      generation_preferences: {
        expected_revision: 1,
        values: { ...settings!.generation_preferences.values, audience_targeting: "families" },
      },
    }, validateImage)).rejects.toBeInstanceOf(PublicationSettingsValidationError);
  });

  it("runs a network-free publication mock with top-level sponsors and unchanged editorial items", async () => {
    const access = (await resolveOutputChannel(db, owner.id, publicationId))!;
    await updatePublicationSettings(db, access.context, owner, {
      sponsor_placements: {
        expected_revision: 0,
        values: [{
          id: "before-newsroom",
          slot: "home_before_newsroom",
          sponsor_name: "Local Cafe",
          headline: "Coffee around the corner",
          body: "See today's menu.",
          landing_url: "https://cafe.example/menu",
          image_url: null,
          enabled: true,
        }],
      },
    }, async () => { throw new Error("No image validation should run without an image"); });
    const editorialItems = [{
      story_id: "story-1", headline: "Council adopts budget", blurb: "The council adopted its annual budget.",
      when_where: "", event_date: "2026-11-12", source_url: "https://town.example/budget",
    }];
    await publishToReader(db, store, {
      id: "edition-1",
      location_id: "town-wa",
      location_name: "Town, WA",
      window_start: "2026-11-09",
      window_end: "2026-11-15",
      published_at: 1,
      headline: "Town this week",
      intro: "Local reporting.",
      items: editorialItems,
    }, "reader-folder");
    const payload = saved.find((file) => file.name === "edition-1.json")!.value as Record<string, unknown>;
    expect(payload.items).toEqual(editorialItems);
    expect(JSON.stringify(payload.items)).not.toContain("Local Cafe");
    expect(payload).toMatchObject({
      publication: { id: publicationId, display_name: "Town Independent" },
      sponsor_placements: { placements: [{ slot: "home_before_newsroom", sponsor_name: "Local Cafe" }] },
    });
    expect(parseEdition(payload)).toMatchObject({
      id: "edition-1",
      items: editorialItems,
      sponsor_placements: { placements: [{ slot: "home_before_newsroom" }] },
    });
    const malformed = structuredClone(payload) as any;
    malformed.sponsor_placements.placements.push({
      id: "unsafe",
      slot: "home_after_top_news",
      sponsor_name: "Unsafe",
      headline: "Unsafe",
      body: "Unsafe",
      landing_url: "http://127.0.0.1/private",
      image_url: null,
    });
    expect(parseEdition(malformed)?.sponsor_placements?.placements).toHaveLength(1);
    expect(await outputChannels(db).findOne({ _id: publicationId })).toMatchObject({ sponsor_placements: { revision: 1 } });
  });

  it("replaces every stored block that resolves to a revision-zero fallback", async () => {
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
      $set: {
        profile: null,
        generation_preferences: { schema_version: 99, revision: 7, values: { voice: "unsupported" } },
        sponsor_placements: { schema_version: 1, revision: "invalid", values: [{ targeting: "families" }] },
      },
    });
    const access = (await resolveOutputChannel(db, owner.id, publicationId))!;
    expect(await getPublicationSettings(db, access.context)).toMatchObject({
      profile: { revision: 0, values: { display_name: "Town Independent" } },
      generation_preferences: { revision: 0, values: { voice: "neutral" } },
      sponsor_placements: { revision: 0, values: [] },
    });
    const updated = await updatePublicationSettings(db, access.context, owner, {
      profile: {
        expected_revision: 0,
        values: { display_name: "Recovered profile", description: null, homepage_url: null, logo_url: null },
      },
      generation_preferences: {
        expected_revision: 0,
        values: { voice: "formal", story_length: "standard", front_summary_density: "standard", newsletter_intro_length: "standard" },
      },
      sponsor_placements: { expected_revision: 0, values: [] },
    });
    expect(updated).toMatchObject({
      profile: { revision: 1, values: { display_name: "Recovered profile" } },
      generation_preferences: { revision: 1, values: { voice: "formal" } },
      sponsor_placements: { revision: 1, values: [] },
    });
  });

  it("rolls back settings mutations when their audit event cannot be inserted", async () => {
    await db.collection(COLLECTIONS.publicationAccessAudit).createIndex(
      { action: 1 },
      { unique: true, name: "fixture_unique_audit_action" },
    );
    await db.collection(COLLECTIONS.publicationAccessAudit).insertOne({
      _id: "audit-blocker",
      action: "profile_updated",
    });
    const access = (await resolveOutputChannel(db, owner.id, publicationId))!;
    await expect(updatePublicationSettings(db, access.context, owner, {
      profile: {
        expected_revision: 0,
        values: { display_name: "Must roll back", description: null, homepage_url: null, logo_url: null },
      },
    })).rejects.toMatchObject({ code: 11000 });
    expect(await outputChannels(db).findOne({ _id: publicationId })).not.toHaveProperty("profile");
  });

  it("keeps sponsor rendering in the two fixed labeled reader slots", async () => {
    const home = await readFile(new URL("../../../../reader-site/src/components/edition/NeighborhoodHome.astro", import.meta.url), "utf8");
    const placement = await readFile(new URL("../../../../reader-site/src/components/edition/SponsorPlacement.astro", import.meta.url), "utf8");
    expect(home.match(/<SponsorPlacement/g)).toHaveLength(2);
    expect(home).toContain('sponsor("home_after_top_news")');
    expect(home).toContain('sponsor("home_before_newsroom")');
    expect(placement).toContain(">Sponsored</p>");
    expect(placement).toContain('rel="sponsored noopener noreferrer"');
  });
});
