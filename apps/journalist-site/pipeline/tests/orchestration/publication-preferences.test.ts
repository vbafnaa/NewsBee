import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { loadSettings } from "../../core/config";
import { defaultRunOptions, withRunContext } from "../../core/run-options";
import { storyCacheKey } from "../../editions/authoring";
import { itemPrompt } from "../../model/story-writer";
import { ensureJobIndexes } from "../../orchestration/jobs";
import { startRun, type OrchestratorDeps } from "../../orchestration/orchestrator";
import { createOutputChannel, resolveOutputChannel } from "../../orchestration/output-channels";
import { ensureRunIndexes, runs } from "../../orchestration/runs";
import {
  publicationPreferenceSnapshot,
  updatePublicationSettings,
} from "../../publications/settings";
import type { ArtifactStore } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { FakeModel } from "../support/fake-model";

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
const publicationId = "c".repeat(32);
const principal = { id: "owner", email: "owner@example.test", role: "owner" as const };
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "folder", saveText: async () => "file", saveJson: async () => "file",
  readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null, removeFile: async () => 0,
};

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-preferences");
});
beforeEach(async () => {
  await db.dropDatabase();
  await Promise.all([ensureRunIndexes(db), ensureJobIndexes(db)]);
  await createOutputChannel(db, principal.id, publicationId, "folder", {
    name: "Preference Weekly",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: ["town-wa"],
  });
  await db.collection(COLLECTIONS.locations).insertOne({
    _id: "town-wa", id: "town-wa", name: "Town, WA", state: "WA", systems: [],
    source_map_version: 1,
  });
  await db.collection("source_map").insertOne({
    _id: "town-wa:fixture", location_id: "town-wa", source_id: "fixture", name: "Fixture",
    reader: "library", section: "events", status: "active", found_by: { method: "library", detail: "Fixture" }, health: {},
  });
});
afterAll(async () => { await client.close(); await server.stop(); });

it("snapshots publication preferences per run and separates writing cache keys without touching editorial evidence", async () => {
  const access = (await resolveOutputChannel(db, principal.id, publicationId))!;
  await updatePublicationSettings(db, access.context, principal, {
    generation_preferences: {
      expected_revision: 0,
      values: { voice: "warm", story_length: "brief", front_summary_density: "compact", newsletter_intro_length: "brief" },
    },
  });
  const firstSnapshot = await publicationPreferenceSnapshot(db, access.context);
  const settings = loadSettings({});
  const deps: OrchestratorDeps = {
    db,
    store,
    settings,
    model: new FakeModel(() => { throw new Error("The network-free run must not call a model"); }),
  };
  await db.collection(COLLECTIONS.publicationGenerations).insertOne({
    _id: "generation-1",
    publication_id: publicationId,
    publication_name: "Preference Weekly",
    status: "running",
    created_at: Date.now() / 1000,
  });
  const first = await startRun(deps, "town-wa", { by: principal.email, kind: "manual" }, defaultRunOptions(), {
    publicationGenerationId: "generation-1",
    publicationId,
    today: "2026-11-08",
    window: ["2026-11-09", "2026-11-15"],
    preferenceSnapshot: firstSnapshot,
  });
  expect(first.run.publication_preference_snapshot).toEqual(firstSnapshot);

  await updatePublicationSettings(db, access.context, principal, {
    generation_preferences: {
      expected_revision: 1,
      values: { voice: "formal", story_length: "detailed", front_summary_density: "standard", newsletter_intro_length: "standard" },
    },
  });
  const secondSnapshot = await publicationPreferenceSnapshot(db, access.context);
  expect(secondSnapshot.revision).toBe(2);
  expect((await runs(db).findOne({ _id: first.run._id }))?.publication_preference_snapshot).toEqual(firstSnapshot);

  const story = {
    id: "story", title: "Town budget hearing", description: "The council scheduled a public budget hearing.",
    venues: ["Town Hall"], kind: "news_report",
  };
  const keyFor = (snapshot: typeof firstSnapshot) => withRunContext({
    db, runId: `run-${snapshot.revision}`, locationId: "town-wa", options: defaultRunOptions(),
    publicationPreferences: snapshot,
  }, () => storyCacheKey(settings, "town-wa", story));
  expect(keyFor(firstSnapshot)).not.toBe(keyFor(secondSnapshot));
  expect(itemPrompt(story, firstSnapshot.explicit_values)).toContain("future edition only");
  expect(itemPrompt(story, firstSnapshot.explicit_values)).toContain("warm but non-promotional");
  expect(itemPrompt(story, firstSnapshot.explicit_values)).not.toMatch(/sponsor|advertiser|targeting/i);
  expect(story).toEqual({
    id: "story", title: "Town budget hearing", description: "The council scheduled a public budget hearing.",
    venues: ["Town Hall"], kind: "news_report",
  });
});
