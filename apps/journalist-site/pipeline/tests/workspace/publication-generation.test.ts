import { mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../accounts/identity";
import { assertGlobalAdmission, blockExecution } from "../../accounts/execution";
import { loadSettings } from "../../core/config";
import { defaultRunOptions } from "../../core/run-options";
import { assertJobExecutionCurrent, claim, complete, enqueue, ensureJobIndexes, recoverExpired, runJobs, withJobExecution, type Job } from "../../orchestration/jobs";
import { executeJob, startRun, type OrchestratorDeps } from "../../orchestration/orchestrator";
import { createOutputChannel } from "../../orchestration/output-channels";
import { assertStandaloneRunControl, ensureRunIndexes, recentRuns, runs, type PipelineRun } from "../../orchestration/runs";
import {
  ensurePublicationGenerationIndexes,
  publicationGenerationDraft,
  publicationGenerationChildren,
  reconcilePublicationGeneration,
  recoverStartingPublicationGenerations,
  startPublicationGeneration,
  createManualPublicationDraft,
  type PublicationDraft,
} from "../../publications/generation";
import { PublicationAccessDenied } from "../../publications/permissions";
import { finishedEditions, publishEdition } from "../../orchestration/publish";
import { LocalArtifacts } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { FakeModel } from "../support/fake-model";
import { recoverPublicationGeneration } from "../../publications/generation-recovery";
import { enterPublicationSupport } from "../../publications/support";
import { ModelBudgetExceeded, modelBudget, startOfDay } from "../../model/budget";
import { UsageAccountingError } from "../../model/runtime";
import { MaintenanceError, RESTORE_STATE } from "../../../../../shared/restore-maintenance";
import { workableRuns } from "../../orchestration/runs";
import { runtimesForRun } from "../../accounts/runtime";
import { resolvePublicationContext } from "../../publications/access";
import { patchPublicationDraft, publicationEditorialWorkspace } from "../../publications/editorial";
import { approvePublicationDraft, createPublicationCorrection, publicationDraftSnapshot, publishPublicationDraft } from "../../publications/releases";
import type { OutputChannelDocument } from "../../orchestration/output-channels";
import { publicationReaderMetadata } from "../../publications/preview";
import { saveCredentialProfile } from "../../accounts/credentials";
import { createNewsroom } from "../../orchestration/create-newsroom";

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let root: string;
let deps: OrchestratorDeps;

const principal: Principal = {
  id: "independent-journalist",
  email: "journalist@example.test",
  role: "owner",
};
const publicationId = "a".repeat(32);
const locations = [
  { id: "north-wa", name: "North, WA" },
  { id: "south-wa", name: "South, WA" },
];
const window: [string, string] = ["2099-11-02", "2099-11-08"];

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-generation");
});

beforeEach(async () => {
  await db.dropDatabase();
  await db.collection("journalist_admins").insertOne({
    principalId: principal.id, email: principal.email, role: principal.role, enabled: true,
  });
  root = path.resolve(".test-artifacts", `publication-generation-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_MODEL", "fixture-model");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "fixture-managed-key");
  await Promise.all([
    ensureRunIndexes(db),
    ensureJobIndexes(db),
    ensurePublicationGenerationIndexes(db),
  ]);
  deps = {
    db,
    store: new LocalArtifacts(root),
    settings: loadSettings({ NEWSBEE_MODE: "cloud", NEWSBEE_MODEL_PROVIDERS: "gemini" }),
    model: new FakeModel(() => {
      throw new Error("The publication orchestration mock must not make live model calls.");
    }),
    principal,
  };
  await createOutputChannel(db, principal.id, publicationId, "fixture-publication-folder", {
    name: "Independent Weekly",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: locations.map((location) => location.id),
  });
  await db.collection(COLLECTIONS.locations).insertMany([
    ...locations.map((location, index) => ({
      _id: location.id,
      ...location,
      state: "WA",
      systems: [],
      government: null,
      source_map_at: 1_700_000_000,
      source_map_version: index + 10,
      source_coverage: {
        status: "ready",
        area: "Fixture boundary",
        gaps: [],
        checked_at: "2099-10-31T00:00:00.000Z",
      },
      preparation: {
        state: "ready",
        updated_at: "2099-10-31T00:00:00.000Z",
        updated_by: principal.id,
        updated_by_email: principal.email,
        reason: "Fixture ready",
      },
    })),
    {
      _id: "other-wa",
      id: "other-wa",
      name: "Other, WA",
      state: "WA",
      systems: [],
      government: null,
      source_map_at: 1_700_000_000,
      source_map_version: 99,
      source_coverage: {
        status: "ready",
        area: "Fixture boundary",
        gaps: [],
        checked_at: "2099-10-31T00:00:00.000Z",
      },
      preparation: {
        state: "ready",
        updated_at: "2099-10-31T00:00:00.000Z",
        updated_by: principal.id,
        updated_by_email: principal.email,
        reason: "Fixture ready",
      },
    },
  ]);
  await db.collection("source_map").insertMany([
    ...locations.map((location) => ({
      _id: `${location.id}:fixture`,
      location_id: location.id,
      source_id: "fixture",
      name: "Fixture source",
      reader: "library",
      section: "events",
      status: "active",
      link_only: false,
      found_by: { method: "fixture", detail: "Network-free fixture" },
      health: { consecutive_failures: 0 },
    })),
    {
      _id: "other-wa:fixture",
      location_id: "other-wa",
      source_id: "fixture",
      name: "Fixture source",
      reader: "library",
      section: "events",
      status: "active",
      link_only: false,
      found_by: { method: "fixture", detail: "Network-free fixture" },
      health: { consecutive_failures: 0 },
    },
  ]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

function options() {
  return {
    ...defaultRunOptions(),
    mode: "autopilot" as const,
    paid: { model: 20 },
    image_mode: "illustrated" as const,
    story_limit: 3,
  };
}

it("projects bounded safe edition activity only from the selected generation's durable child jobs without mutating work", async () => {
  const children = db.collection<{ _id: string; location_id: string; publication_generation_id: string; status: string; created_at: number }>(COLLECTIONS.runs);
  await children.insertMany([
    { _id: "child", location_id: "one", publication_generation_id: "selected", status: "authoring", created_at: 1 },
    { _id: "empty", location_id: "two", publication_generation_id: "selected", status: "collecting", created_at: 2 },
    { _id: "foreign", location_id: "three", publication_generation_id: "other", status: "authoring", created_at: 3 },
  ]);
  const queue = db.collection<Job>(COLLECTIONS.jobs);
  async function seed(run: string, kind: Job["kind"], status: Job["status"], step: string, at: number, result = {}) {
    const id = await enqueue(db, { run_id: run, location_id: "fixture", kind, dedupe_key: `${run}:${step}`,
      payload: { secret: "INTERNAL_PAYLOAD" } });
    await queue.updateOne({ _id: id }, { $set: {
      status, started_at: at, completed_at: status === "running" ? null : at + 1,
      result, error: "INTERNAL_ERROR", log_file: "INTERNAL_LOG",
    } });
    return id;
  }
  for (let i = 0; i < 27; i++) await seed("child", "collect_source", "completed", `source-${i}`, 100 + i);
  for (let i = 0; i < 9; i++) await seed("child", "author_story", "completed", `story-${i}`, 200 + i);
  const current = await seed("child", "author_story", "running", "story-current", 300);
  await seed("child", "author_story", "completed", "skipped", 400, { skipped: true });
  await seed("child", "author_story", "completed", "cancelled-result", 400, { cancelled: true });
  await seed("child", "author_story", "cancelled", "cancelled", 400);
  await seed("foreign", "author_story", "completed", "foreign", 1000);
  const before = await queue.find({}).toArray();
  const rows = await publicationGenerationChildren(db, ["selected"]);
  expect(rows.map((row) => row._id)).toEqual(["child", "empty"]);
  expect(rows[0].work).toEqual({
    source_checks_completed: 27, story_steps_completed: 9, active: ["Writing a story"],
    last_started_at: 300, last_completed_at: 209,
  });
  expect(rows[1].work).toEqual({
    source_checks_completed: 0, story_steps_completed: 0, active: [],
    last_started_at: null, last_completed_at: null,
  });
  expect(JSON.stringify(rows)).not.toMatch(/INTERNAL_|author_story|collect_source|foreign/);
  expect(await queue.find({}).toArray()).toEqual(before);
  await queue.updateOne({ _id: current }, { $set: { status: "completed", completed_at: 350 } });
  expect((await publicationGenerationChildren(db, ["selected"]))[0].work).toMatchObject({
    story_steps_completed: 10, active: [], last_completed_at: 350,
  });
  await seed("child", "author_story", "failed", "failed", 450);
  expect((await publicationGenerationChildren(db, ["selected"]))[0].work).toMatchObject({
    story_steps_completed: 10, last_completed_at: 350,
  });
  expect(await publicationGenerationChildren(db, ["missing"])).toEqual([]);
  expect(await publicationGenerationChildren(db, [])).toEqual([]);
});

describe("manual edition", () => {
  const input = {
    publicationId, locationIds: locations.map((location) => location.id), window, idempotencyKey: "manual-request-1",
  };
  it("creates, edits and reloads a ready local fixture with unavailable Reader links without bypassing readiness or dispatching work", async () => {
    vi.stubEnv("NEWSBEE_READER_SITE_URL", "not a URL");
    expect(publicationReaderMetadata()).toMatchObject({ readerBaseUrl: null, readerLink: { state: "unavailable" } });
    const { draft } = await createManualPublicationDraft(db, principal, input);
    const context = (await resolvePublicationContext<OutputChannelDocument>(db, principal.id, publicationId))!;
    const saved = await patchPublicationDraft(db, context, draft._id, 0, {
      type: "draft", headline: "Reporting remains writable", intro: "Saved despite optional link configuration.",
    }, principal);
    const reloaded = (await publicationEditorialWorkspace(db, context, draft._id))!;
    expect(reloaded.draft.revision).toBe(saved.revision);
    expect(reloaded.draft.presentation).toEqual(saved.presentation);
    await db.collection(COLLECTIONS.locations).updateOne({ _id: locations[0].id as never }, {
      $set: { "preparation.state": "suspended" },
    });
    await expect(createManualPublicationDraft(db, principal, {
      ...input, idempotencyKey: "unready-reader-fixture",
    })).rejects.toThrow("Invalid generation locations");
    for (const collection of [COLLECTIONS.publicationGenerations, COLLECTIONS.runs, COLLECTIONS.jobs, COLLECTIONS.modelUsage]) {
      expect(await db.collection(collection).countDocuments()).toBe(0);
    }
  });
  it("allows an assigned Admin to write manually without provider keys or funding records", async () => {
    const admin: Principal = { id: "manual-admin", email: "manual-admin@example.test", role: "admin" };
    await db.collection("journalist_admins").insertOne({ principalId: admin.id, email: admin.email, role: admin.role, enabled: true });
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
      $set: { members: [{ principal_id: admin.id, role: "editor" }] },
    });
    const result = await createManualPublicationDraft(db, admin, input);
    expect(result.draft).toMatchObject({ origin: "manual", telemetry: { actor: { id: admin.id }, funding: [] } });
    expect(await db.collection(COLLECTIONS.publicationGenerations).countDocuments()).toBe(0);
    expect(await runs(db).countDocuments()).toBe(0);
    expect(await db.collection("journalist_funding_audit").countDocuments()).toBe(0);
  });
  it("denies journalist newsroom creation before any provisioning and allows explicit Admin creation without extra memberships", async () => {
    const steps = {
      validate: vi.fn(async () => {}),
      planFolder: vi.fn(async () => ({ id: "mongo:created", drive: false })),
      provision: vi.fn(async () => {}),
    };
    const input = { name: "Operator-created", enabled: true, selectedLocationIds: [], destinations: [{ type: "reader" as const, url: "" }] };
    await expect(createNewsroom(db, principal, "journalist-creation", input, steps)).rejects.toBeInstanceOf(PublicationAccessDenied);
    expect(steps.validate).not.toHaveBeenCalled();
    expect(steps.provision).not.toHaveBeenCalled();
    expect(await db.collection(COLLECTIONS.outputChannelCreations).countDocuments()).toBe(0);
    const admin: Principal = { id: "creating-admin", email: "creating-admin@example.test", role: "admin" };
    await db.collection("journalist_admins").insertOne({ principalId: admin.id, email: admin.email, role: "admin", enabled: true });
    const created = await createNewsroom(db, admin, "admin-creation", input, steps);
    expect(created.name).toBe("Operator-created");
    expect(steps.provision).toHaveBeenCalledTimes(1);
    expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: created.id })).toMatchObject({
      owner_id: admin.id, members: [],
    });
    expect(await db.collection("journalist_admins").findOne({ principalId: admin.id })).toMatchObject({ role: "admin" });
  });
  it("durably deduplicates actor/publication retries without fake generation or paid work", async () => {
    await db.collection("run_budgets").insertOne({
      _id: `model-daily:managed:${new Date().toISOString().slice(0, 10)}`, used: deps.settings.modelDailyCalls,
    });
    expect((await modelBudget(db, deps.settings)).exhausted).toBe(true);
    const [first, retry] = await Promise.all([
      createManualPublicationDraft(db, principal, input),
      createManualPublicationDraft(db, principal, input),
    ]);
    expect(first.draft._id).toBe(retry.draft._id);
    expect([first.created, retry.created].sort()).toEqual([false, true]);
    expect(first.draft).toMatchObject({
      origin: "manual", editorial_status: "editing", revision: 0,
      stories: [], telemetry: { funding: [] }, presentation: { stories: [], story_order: [] },
    });
    expect(first.draft).not.toHaveProperty("generation_id");
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({
      action: "manual_draft_created", resource_id: first.draft._id,
    })).toBe(1);
    await expect(createManualPublicationDraft(db, principal, {
      ...input, window: ["2099-11-09", "2099-11-15"],
    })).rejects.toThrow("different edition details");
    const second = await createManualPublicationDraft(db, principal, { ...input, idempotencyKey: "manual-request-2" });
    expect(second.draft._id).not.toBe(first.draft._id);
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId as never }, {
      $set: { members: [{ principal_id: "assigned-writer", role: "editor" }] },
    });
    const otherActor = await createManualPublicationDraft(db, { id: "assigned-writer", email: "writer@example.test", role: "editor" }, input);
    expect(otherActor.draft._id).not.toBe(first.draft._id);
    for (const collection of [COLLECTIONS.publicationGenerations, COLLECTIONS.runs, COLLECTIONS.jobs, COLLECTIONS.modelUsage]) {
      expect(await db.collection(collection).countDocuments()).toBe(0);
    }
    const revision = (await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId as never }))!.lifecycle_revision;
    await db.command({ collMod: COLLECTIONS.publicationAccessAudit, validator: { action: { $ne: "manual_draft_created" } } });
    await expect(createManualPublicationDraft(db, principal, { ...input, idempotencyKey: "audit-failure-request" })).rejects.toThrow();
    expect(await db.collection(COLLECTIONS.publicationDrafts).countDocuments()).toBe(3);
    expect((await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId as never }))!.lifecycle_revision).toBe(revision);
  });

  it("rechecks current scope/readiness on retry and validates the exact seven-day window", async () => {
    await expect(createManualPublicationDraft(db, { ...principal, id: "unrelated" }, input)).rejects.toBeInstanceOf(PublicationAccessDenied);
    await expect(createManualPublicationDraft(db, principal, { ...input, locationIds: ["other-wa"] })).rejects.toThrow("belong to this publication");
    await expect(createManualPublicationDraft(db, principal, { ...input, window: ["2099-11-02", "2099-11-07"] })).rejects.toThrow("exactly 7 days");
    await createManualPublicationDraft(db, principal, input);
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId as never }, {
      $set: { allowed_location_ids: [locations[0].id] },
    });
    await expect(createManualPublicationDraft(db, principal, input)).rejects.toThrow("belong to this publication");
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId as never }, {
      $set: { allowed_location_ids: input.locationIds },
    });
    await db.collection(COLLECTIONS.locations).updateOne({ _id: locations[0].id as never }, {
      $set: { "preparation.state": "suspended" },
    });
    await expect(createManualPublicationDraft(db, principal, input)).rejects.toThrow("Invalid generation locations");
    expect(await db.collection(COLLECTIONS.publicationDrafts).countDocuments()).toBe(1);
  });

  it("saves/reloads original reporting and explicitly approves/publishes the existing immutable release contract", async () => {
    const { draft } = await createManualPublicationDraft(db, principal, input);
    const context = (await resolvePublicationContext<OutputChannelDocument>(db, principal.id, publicationId))!;
    await expect(patchPublicationDraft(db, context, draft._id, 0, { type: "ready_for_approval" }, principal)).rejects.toThrow("Include at least one story");
    await expect(approvePublicationDraft(db, context, draft._id, 0, principal)).rejects.toThrow("not ready");
    await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).updateOne({ _id: draft._id }, {
      $set: { editorial_status: "ready_for_approval" },
    });
    await expect(approvePublicationDraft(db, context, draft._id, 0, principal)).rejects.toThrow("Include at least one story");
    await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).updateOne({ _id: draft._id }, {
      $set: { editorial_status: "editing" },
    });
    let saved = await patchPublicationDraft(db, context, draft._id, 0, {
      type: "add_original_story", story: {
        headline: "Council opens a public workshop", body: "Residents can review the new park proposal at the public workshop.",
        byline: "Local Reporter", sectionId: "news", locationTags: [locations[0].id],
        sourceMetadata: [{ type: "observation", name: "Reporter at the meeting", url: null, note: "Direct attendance and notes." }],
      },
    }, principal);
    saved = await patchPublicationDraft(db, context, draft._id, saved.revision, { type: "draft", intro: "Original local reporting this week." }, principal);
    const reloaded = (await publicationEditorialWorkspace(db, context, draft._id))!;
    expect(reloaded.draft.presentation).toEqual(saved.presentation);
    const preview = await publicationDraftSnapshot(db, context, reloaded.draft, { requireComplete: true });
    expect(preview.items[0].source_references).toEqual([]);
    expect(preview.draft_revision).toBe(saved.revision);
    saved = await patchPublicationDraft(db, context, draft._id, saved.revision, { type: "ready_for_approval" }, principal);
    const approved = await approvePublicationDraft(db, context, draft._id, saved.revision, principal);
    expect(approved.release).toBeUndefined();
    const published = await publishPublicationDraft(db, deps.store, context, draft._id, approved.revision, approved.approval!.content_hash, principal);
    expect(published.release?.payload.items[0]).toMatchObject({ origin: "original", byline: "Local Reporter" });
    const correction = await createPublicationCorrection(db, context, published.release!.release_id, "Clarify the workshop time", principal);
    expect(correction.origin).toBe("manual");
    expect(correction).not.toHaveProperty("generation_id");
    expect(correction).not.toHaveProperty("manual_creation");
    expect(await db.collection(COLLECTIONS.publicationGenerations).countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.modelUsage).countDocuments()).toBe(0);
  });
});

async function seedCompletedChild(
  run: PipelineRun,
  values: {
    uniqueTitle: string;
    uniqueUrl: string;
    heldTitle?: string;
  },
) {
  const sharedStoryId = "shared-story";
  const uniqueStoryId = `${run.location_id}-unique`;
  const heldStoryId = `${run.location_id}-held`;
  await db.collection(COLLECTIONS.editions).insertOne({
    id: run._id,
    run_id: run._id,
    location_id: run.location_id,
    location_name: run.location_name,
    status: "built",
    published: {
      items: [
        { story_id: sharedStoryId },
        { story_id: uniqueStoryId },
      ],
    },
  });
  const entry = (
    storyId: string,
    position: number,
    headline: string,
    url: string,
    disposition = "checks_passed",
    validationErrors: string[] = [],
  ) => ({
    id: `${run._id}:${storyId}`,
    edition_id: run._id,
    position,
    disposition,
    story_id: storyId,
    source_id: "fixture",
    source_type: "library",
    tier: "local",
    section: "events",
    event_date: "2099-11-04",
    result: {
      story: {
        id: storyId,
        title: headline,
        description: `${headline} description`,
        kind: "event",
      },
      draft: {
        headline,
        summary: `${headline} summary`,
      },
      source_url: url,
      sources: [{ name: "Fixture source", url }],
      when_where: "Nov. 4 at Town Hall",
      validation_errors: validationErrors,
      image_pipeline: { status: "illustrated", policy: "fixture" },
      illustration: { id: `${storyId}-illustration` },
    },
  });
  await db.collection(COLLECTIONS.editionEntries).insertMany([
    entry(sharedStoryId, 0, "Shared council workshop", "https://civic.example.test/shared?utm_source=fixture"),
    entry(uniqueStoryId, 1, values.uniqueTitle, values.uniqueUrl),
    ...(values.heldTitle
      ? [entry(heldStoryId, 2, values.heldTitle, `${values.uniqueUrl}/held`, "held", ["Needs editor review"])]
      : []),
  ]);
  await db.collection("collected_items").insertMany([
    {
      _id: `${run._id}:shared`,
      run_id: run._id,
      location_id: run.location_id,
      story_id: sharedStoryId,
      status: "published",
    },
    {
      _id: `${run._id}:unique`,
      run_id: run._id,
      location_id: run.location_id,
      story_id: uniqueStoryId,
      status: "published",
    },
    ...(values.heldTitle
      ? [{
        _id: `${run._id}:held`,
        run_id: run._id,
        location_id: run.location_id,
        story_id: heldStoryId,
        status: "held",
      }]
      : []),
  ]);
  await db.collection("journalist_funding_audit").insertOne({
    run_id: run._id,
    sponsor_id: principal.id,
    funding: "platform",
    provider: "fake",
    model: "fixture-model",
    role: "writing",
    ok: true,
    at: Date.now() / 1000,
  });
  await runs(db).updateOne(
    { _id: run._id },
    {
      $set: {
        status: "built",
        draft_id: run._id,
        edition_id: run._id,
        completed_at: Date.now() / 1000,
        updated_at: Date.now() / 1000,
        published: {
          items: 2,
          held: values.heldTitle ? 1 : 0,
          held_reasons: values.heldTitle ? { "Needs editor review": 1 } : {},
          artifacts: {},
        },
      },
    },
  );
}

async function seedBridgedStories(first: PipelineRun, second: PipelineRun) {
  const rows = [
    {
      run: first,
      storyId: "bridge-source",
      position: 10,
      stableId: "stable-source",
      headline: "Bridge source story",
      url: "https://bridge.example.test/source-a",
    },
    {
      run: first,
      storyId: "bridge-stable",
      position: 11,
      stableId: "stable-target",
      headline: "Bridge stable story",
      url: "https://bridge.example.test/source-b",
    },
    {
      run: second,
      storyId: "bridge-link",
      position: 10,
      stableId: "stable-target",
      headline: "Bridge linking story",
      url: "https://bridge.example.test/source-a?utm_source=fixture",
    },
  ];
  for (const row of rows) {
    await db.collection(COLLECTIONS.editions).updateOne(
      { id: row.run._id },
      { $push: { "published.items": { story_id: row.storyId } } },
    );
    await db.collection(COLLECTIONS.editionEntries).insertOne({
      id: `${row.run._id}:${row.storyId}`,
      edition_id: row.run._id,
      position: row.position,
      disposition: "checks_passed",
      story_id: row.storyId,
      source_id: "fixture",
      source_type: "library",
      tier: "local",
      section: "events",
      event_date: "2099-11-05",
      result: {
        story: {
          id: row.stableId,
          title: row.headline,
          description: `${row.headline} description`,
          kind: "event",
        },
        draft: { headline: row.headline, summary: `${row.headline} summary` },
        sources: [{ name: "Bridge source", url: row.url }],
      },
    });
    await db.collection("collected_items").insertOne({
      _id: `${row.run._id}:${row.storyId}`,
      run_id: row.run._id,
      location_id: row.run.location_id,
      story_id: row.storyId,
      status: "published",
    });
  }
}

describe("guided multi-location publication generation", () => {
  it("allows an assigned journalist to generate within the allowed boundary without operator privileges", async () => {
    const journalist: Principal = { id: "assigned-journalist", email: "assigned@example.test", role: "editor" };
    await db.collection("journalist_admins").insertOne({
      principalId: journalist.id, email: journalist.email, role: "editor", enabled: true,
    });
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
      $set: { members: [{ principal_id: journalist.id, role: "editor" }] },
    });
    const result = await startPublicationGeneration(deps, journalist, {
      publicationId, locationIds: [locations[0].id], window, options: options(), idempotencyKey: "assigned-journalist-generation",
    });
    expect(result.started).toBe(true);
    expect(result.generation.initiated_by).toBe(journalist.id);
    expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId }))
      .toMatchObject({ lifecycle_revision: 1 });
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({ action: "privileged_write_access" })).toBe(0);
  });

  it("rejects a selected location removed from the allowed boundary before creating parent or child work", async () => {
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
      $set: { allowed_location_ids: [locations[0].id] },
    });
    await expect(startPublicationGeneration(deps, principal, {
      publicationId, locationIds: [locations[1].id], window, options: options(), idempotencyKey: "outside-allowed-boundary",
    })).rejects.toThrow("every location must belong");
    expect(await db.collection(COLLECTIONS.publicationGenerations).countDocuments()).toBe(0);
    expect(await runs(db).countDocuments()).toBe(0);
  });

  it("runs a network-free two-location parent/child mock into one additive unpublished draft", async () => {
    const request = {
      publicationId,
      locationIds: locations.map((location) => location.id),
      window,
      options: options(),
      idempotencyKey: "fixture-request-0001",
    };
    const started = await startPublicationGeneration(deps, principal, request);
    expect(started.started).toBe(true);
    expect(started.generation).toMatchObject({
      status: "running",
      managed_execution: true,
      progress: { total: 2, completed: 0, failed: 0 },
    });
    let children = await runs(db).find({ publication_generation_id: started.generation._id }).sort({ location_id: 1 }).toArray();
    expect(children).toHaveLength(2);
    expect(children.every((child) =>
      child.admission === "publication"
      && child.publication_id === publicationId
      && child.execution?.source === "platform")).toBe(true);
    await db.collection(COLLECTIONS.jobs).deleteMany({ run_id: children[0]._id });
    await db.collection(COLLECTIONS.jobs).deleteMany({ run_id: children[1]._id });
    await runs(db).deleteOne({ _id: children[1]._id });
    await db.collection(COLLECTIONS.publicationGenerations).updateOne(
      { _id: started.generation._id },
      { $set: { status: "starting", child_run_ids: [] } },
    );
    expect(await recoverStartingPublicationGenerations(deps)).toBe(1);
    children = await runs(db).find({ publication_generation_id: started.generation._id }).sort({ location_id: 1 }).toArray();
    expect(await runs(db).countDocuments({ publication_generation_id: started.generation._id })).toBe(2);
    expect(await db.collection(COLLECTIONS.jobs).countDocuments({
      run_id: { $in: children.map((child) => child._id) },
      kind: "plan_sources",
    })).toBe(2);
    expect(await db.collection(COLLECTIONS.publicationGenerations).findOne({ _id: started.generation._id }))
      .toMatchObject({ status: "running", child_run_ids: children.map((child) => child._id) });
    await db.collection(COLLECTIONS.publicationGenerations).updateOne(
      { _id: started.generation._id },
      { $set: { status: "failed" } },
    );
    await expect(assertGlobalAdmission(db, children[0]._id, started.generation._id))
      .rejects.toThrow("not executable (failed)");
    await db.collection(COLLECTIONS.publicationGenerations).updateOne(
      { _id: started.generation._id },
      { $set: { status: "running" } },
    );
    await expect(startRun(
      deps,
      "other-wa",
      { kind: "manual", by: principal.email },
      options(),
    )).rejects.toThrow("assigned newsroom");

    await seedCompletedChild(children[0], {
      uniqueTitle: "North library opens a tool room",
      uniqueUrl: "https://north.example.test/tool-room",
      heldTitle: "North notice needs review",
    });
    await seedCompletedChild(children[1], {
      uniqueTitle: "South park adds evening hours",
      uniqueUrl: "https://south.example.test/evening-hours",
    });
    const bridgeOrder = [...children].sort((left, right) => left._id.localeCompare(right._id));
    await seedBridgedStories(bridgeOrder[0], bridgeOrder[1]);
    const completed = await reconcilePublicationGeneration(db, started.generation._id);
    expect(completed).toMatchObject({
      status: "ready",
      progress: { total: 2, completed: 2, failed: 0 },
    });
    const draft = await publicationGenerationDraft(db, publicationId, completed!.draft_id);
    expect(draft).toMatchObject({
      unpublished: true,
      editable: true,
      distribution: { reader: false, email: false },
      versions: {
        source_maps: [
          { location_id: "north-wa", version: 10 },
          { location_id: "south-wa", version: 11 },
        ],
      },
      telemetry: {
        actor: { id: principal.id, email: principal.email },
        funding: [expect.objectContaining({ funding: "platform", provider: "fake", calls: 2 })],
      },
    });
    expect(draft?.stories).toHaveLength(5);
    const shared = draft?.stories.find((story) => story.snapshot.headline === "Shared council workshop");
    expect(shared?.location_tags.map((location) => location.id).sort()).toEqual(["north-wa", "south-wa"]);
    expect(shared?.references).toHaveLength(2);
    expect(shared?.snapshot.sources).toEqual([
      { name: "Fixture source", url: "https://civic.example.test/shared" },
    ]);
    expect(draft?.stories.find((story) => story.review.status === "held")).toMatchObject({
      review: { status: "held", flags: ["Needs editor review"] },
      references: [expect.objectContaining({ collected_item_ids: [expect.stringContaining(":held")] })],
    });
    const bridged = draft?.stories.find((story) =>
      story.references.some((reference) => reference.story_id === "bridge-link"));
    expect(bridged?.references.map((reference) => reference.story_id).sort()).toEqual([
      "bridge-link",
      "bridge-source",
      "bridge-stable",
    ]);
    expect(bridged?.location_tags.map((location) => location.id).sort()).toEqual(["north-wa", "south-wa"]);
    expect(bridged?.snapshot.sources.map((source) => source.url).sort()).toEqual([
      "https://bridge.example.test/source-a",
      "https://bridge.example.test/source-b",
    ]);
    expect(await finishedEditions(db, children[0].location_id)).toEqual([]);
    expect(await recentRuns(db, { locationId: children[0].location_id })).toEqual([]);
    await expect(publishEdition(db, deps.store, children[0].location_id, children[0]._id, principal.email))
      .rejects.toThrow("cannot be published separately");
    await expect(assertStandaloneRunControl(db, children[0]._id))
      .rejects.toThrow("managed by its combined publication generation");

    const retried = await startPublicationGeneration(deps, principal, request);
    expect(retried).toMatchObject({ started: false, generation: { _id: started.generation._id, draft_id: draft?._id } });
    expect(await db.collection(COLLECTIONS.publicationGenerations).countDocuments()).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationDrafts).countDocuments()).toBe(1);
    const generatedHeadline = draft!.stories[0].snapshot.headline;
    await db.collection(COLLECTIONS.publicationDrafts).updateOne(
      { _id: draft!._id },
      { $set: { "presentation.stories.0.headline": "Journalist-edited headline" } },
    );
    await reconcilePublicationGeneration(db, started.generation._id);
    const preserved = await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).findOne({ _id: draft!._id });
    expect(preserved?.stories[0].snapshot.headline).toBe(generatedHeadline);
    expect(preserved?.presentation.stories[0].headline).toBe("Journalist-edited headline");

    expect(await db.collection(COLLECTIONS.outputChannelEditions).countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.outputChannelFiles).countDocuments()).toBe(0);
    expect(await db.collection("email_outbox").countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId }))
      .toMatchObject({ published_location_ids: [] });
    expect(await runs(db).countDocuments({ publication_generation_id: started.generation._id, status: "published" })).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it("blocks on sibling failure without discarding a publishing child or freeing admission", async () => {
    const started = await startPublicationGeneration(deps, principal, {
      publicationId,
      locationIds: locations.map((location) => location.id),
      window,
      options: options(),
      idempotencyKey: "fixture-publishing-failure",
    });
    const children = await runs(db).find({
      publication_generation_id: started.generation._id,
    }).sort({ location_id: 1 }).toArray();
    await runs(db).updateOne(
      { _id: children[0]._id },
      { $set: { status: "failed", error: "Fixture sibling failure" } },
    );
    await runs(db).updateOne(
      { _id: children[1]._id },
      { $set: { status: "publishing" } },
    );

    const waiting = await reconcilePublicationGeneration(db, started.generation._id);
    expect(waiting).toMatchObject({
      status: "blocked",
      error: expect.stringContaining("Fixture sibling failure"),
      progress: { total: 2, completed: 0, failed: 1 },
    });
    expect(await runs(db).findOne({ _id: children[1]._id })).toMatchObject({ status: "publishing" });

    await runs(db).updateOne(
      { _id: children[1]._id },
      { $set: { status: "built", completed_at: Date.now() / 1000 } },
    );
    const failed = await reconcilePublicationGeneration(db, started.generation._id);
    expect(failed).toMatchObject({
      status: "blocked",
      error: expect.stringContaining("Fixture sibling failure"),
      progress: { total: 2, completed: 1, failed: 1 },
    });
    expect(await runs(db).countDocuments({
      publication_generation_id: started.generation._id,
      status: "cancelled",
    })).toBe(0);
  });

  it("blocks instead of combining when a child was published outside the parent workflow", async () => {
    const started = await startPublicationGeneration(deps, principal, {
      publicationId,
      locationIds: locations.map((location) => location.id),
      window,
      options: options(),
      idempotencyKey: "fixture-external-publish",
    });
    const children = await runs(db).find({
      publication_generation_id: started.generation._id,
    }).sort({ location_id: 1 }).toArray();
    await runs(db).updateOne({ _id: children[0]._id }, { $set: { status: "built" } });
    await runs(db).updateOne({ _id: children[1]._id }, { $set: { status: "published" } });

    const failed = await reconcilePublicationGeneration(db, started.generation._id);
    expect(failed).toMatchObject({
      status: "blocked",
      error: expect.stringContaining("published outside the combined workflow"),
      draft_id: null,
    });
    expect(await db.collection(COLLECTIONS.publicationDrafts).countDocuments()).toBe(0);
  });

  it("rejects unassigned, non-ready, foreign, duplicate, and over-limit requests before starting children", async () => {
    await db.collection(COLLECTIONS.outputChannels).updateOne(
      { _id: publicationId },
      { $set: { members: [{ principal_id: "publication-editor", role: "editor" }] } },
    );
    await expect(startPublicationGeneration(deps, {
      id: "unassigned-editor",
      email: "editor@example.test",
      role: "editor",
    }, {
      publicationId,
      locationIds: [locations[0].id],
      window,
      options: options(),
      idempotencyKey: "fixture-request-editor",
    })).rejects.toBeInstanceOf(PublicationAccessDenied);
    await db.collection(COLLECTIONS.locations).updateOne(
      { _id: locations[1].id },
      { $set: { "preparation.state": "preparing" } },
    );
    await expect(startPublicationGeneration(deps, principal, {
      publicationId,
      locationIds: locations.map((location) => location.id),
      window,
      options: options(),
      idempotencyKey: "fixture-request-0002",
    })).rejects.toThrow("South, WA is preparing");
    await expect(startPublicationGeneration(deps, principal, {
      publicationId,
      locationIds: [locations[0].id, locations[0].id],
      window,
      options: options(),
      idempotencyKey: "fixture-request-0003",
    })).rejects.toThrow("unique locations");
    await expect(startPublicationGeneration(deps, principal, {
      publicationId,
      locationIds: Array.from({ length: 9 }, (_, index) => `location-${index}`),
      window,
      options: options(),
      idempotencyKey: "fixture-request-limit",
    })).rejects.toThrow("choose 1 to 8");
    await expect(startPublicationGeneration(deps, principal, {
      publicationId,
      locationIds: ["other-wa"],
      window,
      options: options(),
      idempotencyKey: "fixture-request-0004",
    })).rejects.toThrow("must belong to this publication");
    expect(await db.collection(COLLECTIONS.publicationGenerations).countDocuments()).toBe(0);
    expect(await runs(db).countDocuments()).toBe(0);
  });
});

describe("targeted publication generation recovery", () => {
  async function startedGeneration() {
    const { generation } = await startPublicationGeneration(deps, principal, {
      publicationId, locationIds: locations.map(({ id }) => id), window, options: options(),
      idempotencyKey: "fixture-recovery-generation",
    });
    const children = await runs(db).find({ publication_generation_id: generation._id }).sort({ location_id: 1 }).toArray();
    return { generation, children };
  }

  async function assignedJournalist() {
    const journalist: Principal = { id: "another-journalist", email: "another@example.test", role: "editor" };
    await db.collection("journalist_admins").insertOne({
      principalId: journalist.id, email: journalist.email, role: journalist.role, enabled: true,
    });
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
      $set: { members: [{ principal_id: journalist.id, role: "editor" }] },
    });
    return journalist;
  }

  it("holds admission and blocks dispatch after a child allowance failure; polling never reconnects it", async () => {
    const { generation, children } = await startedGeneration();
    const parents = db.collection(COLLECTIONS.publicationGenerations);
    await parents.dropIndex("one_active_publication_generation_v2");
    await parents.createIndex({ admission: 1 }, { name: "one_active_publication_generation", unique: true,
      partialFilterExpression: { admission: "newsroom", status: { $in: ["starting", "running", "combining"] } } });
    const error = new ModelBudgetExceeded("managed_platform", startOfDay() + 86400, 200);
    await blockExecution(db, children[0]._id, error);
    const indexes = (await parents.listIndexes().toArray()).map((index) => index.name);
    expect(indexes).toContain("one_active_publication_generation_v2");
    expect(indexes).not.toContain("one_active_publication_generation");
    expect(await reconcilePublicationGeneration(db, generation._id)).toMatchObject({
      status: "blocked", execution_blocked: { code: "model_daily_allowance", scope: "managed_platform", resets_at: error.resets_at },
    });
    expect(await workableRuns(db)).toEqual([]);
    await expect(assertGlobalAdmission(db)).rejects.toThrow("unfinished");
    expect(await recoverStartingPublicationGenerations(deps)).toBe(0);
    await expect(db.collection(COLLECTIONS.publicationGenerations).insertOne({
      _id: "contradictory-parent" as never, admission: "newsroom", status: "starting",
    })).rejects.toMatchObject({ code: 11000 });
    expect((await runs(db).findOne({ _id: children[0]._id }))?.execution_blocked?.code).toBe("model_daily_allowance");
  });

  it("lets another assigned journalist explicitly resume managed work without replacing its initiator", async () => {
    const { generation, children } = await startedGeneration();
    const journalist = await assignedJournalist();
    await blockExecution(db, children[0]._id, new Error("Credentials require deliberate recovery."));
    const recovered = await recoverPublicationGeneration(deps, journalist, {
      publicationId, generationId: generation._id, action: "resume",
    });
    expect(recovered?.status).toBe("running");
    const resumed = await runs(db).findOne({ _id: children[0]._id });
    expect(resumed).toMatchObject({ execution: { source: "platform", sponsorId: journalist.id, initiatedBy: principal.id } });
    expect(resumed?.execution_blocked).toBeUndefined();
    expect(await runs(db).countDocuments({ publication_generation_id: generation._id })).toBe(2);
    expect(await db.collection("journalist_execution_audit").countDocuments({ generation_id: generation._id, by: journalist.id })).toBe(1);
    await expect(recoverPublicationGeneration(deps, journalist, {
      publicationId, generationId: generation._id, action: "resume",
    })).rejects.toThrow("Only a blocked");
  });

  it("retries only the failed step and interrupted siblings, preserving completed child drafts and paid counters", async () => {
    const { generation, children } = await startedGeneration();
    await seedCompletedChild(children[0], { uniqueTitle: "Saved work", uniqueUrl: "https://example.test/saved" });
    const completedChild = await runs(db).findOne({ _id: children[0]._id });
    const childJobs = await runJobs(db, children[1]._id);
    await db.collection(COLLECTIONS.jobs).updateOne({ _id: childJobs[0]._id as never }, {
      $set: { status: "failed", error: "Fixture transient step failure", attempts: 3 },
    });
    await runs(db).updateOne({ _id: children[1]._id }, {
      $set: { status: "failed", error: "Fixture transient step failure" },
    });
    await db.collection("run_budgets").insertOne({ _id: "paid-fixture" as never, used: 7 });
    await reconcilePublicationGeneration(db, generation._id);
    await recoverPublicationGeneration(deps, principal, { publicationId, generationId: generation._id, action: "retry" });
    expect(await runs(db).findOne({ _id: children[0]._id })).toEqual(completedChild);
    expect(await db.collection(COLLECTIONS.editions).findOne({ run_id: children[0]._id })).toBeTruthy();
    expect(await runs(db).countDocuments({ publication_generation_id: generation._id })).toBe(2);
    expect((await runJobs(db, children[1]._id))[0]).toMatchObject({ _id: childJobs[0]._id, status: "pending" });
    expect(await db.collection("run_budgets").findOne({ _id: "paid-fixture" as never })).toMatchObject({ used: 7 });
  });

  it("creates only a missing child on explicit retry, retaining the completed child", async () => {
    const { generation, children } = await startedGeneration();
    await seedCompletedChild(children[0], { uniqueTitle: "Retained", uniqueUrl: "https://example.test/retained" });
    await runs(db).deleteOne({ _id: children[1]._id });
    await db.collection(COLLECTIONS.jobs).deleteMany({ run_id: children[1]._id });
    await reconcilePublicationGeneration(db, generation._id);
    await expect(recoverPublicationGeneration(deps, principal, {
      publicationId, generationId: generation._id, action: "resume",
    })).rejects.toThrow("Retry missing/failed");
    await recoverPublicationGeneration(deps, principal, { publicationId, generationId: generation._id, action: "retry" });
    expect(await runs(db).countDocuments({ publication_generation_id: generation._id })).toBe(2);
    expect(await runs(db).findOne({ _id: children[0]._id })).toMatchObject({ status: "built" });
    expect(await runs(db).findOne({ _id: children[1]._id })).toBeNull();
  });

  it("does not inherit another journalist's legacy credentials and audits deliberate managed sponsorship", async () => {
    const { generation, children } = await startedGeneration();
    const journalist = await assignedJournalist();
    await runs(db).updateOne({ _id: children[0]._id }, { $set: { "execution.source": "personal" } });
    await blockExecution(db, children[0]._id, new Error("Legacy sponsor unavailable."));
    await expect(recoverPublicationGeneration(deps, journalist, {
      publicationId, generationId: generation._id, action: "resume",
    })).rejects.toThrow("funding");
    expect((await runs(db).findOne({ _id: children[0]._id }))?.execution?.sponsorId).toBe(principal.id);
    await recoverPublicationGeneration(deps, journalist, {
      publicationId, generationId: generation._id, action: "resume",
      funding: "platform", reason: "Publication deliberately sponsors the remaining local reporting.",
    });
    const audit = await db.collection("journalist_execution_audit").findOne({ generation_id: generation._id });
    expect(audit?.bindings[0]).toMatchObject({
      previous: { source: "personal", sponsorId: principal.id },
      next: { source: "platform", sponsorId: journalist.id, initiatedBy: principal.id },
    });
    await runs(db).updateOne({ _id: children[1]._id }, { $set: { publication_id: "incompatible-publication" } });
    await blockExecution(db, children[0]._id, new Error("Explicit retry required."));
    await expect(recoverPublicationGeneration(deps, journalist, {
      publicationId, generationId: generation._id, action: "retry",
    })).rejects.toThrow("incompatible location runs");
    expect(await db.collection(COLLECTIONS.publicationGenerations).findOne({ _id: generation._id as never }))
      .toMatchObject({ status: "blocked", error: expect.stringContaining("incompatible location runs") });
    expect(await recoverStartingPublicationGenerations(deps)).toBe(0);
  });

  it("requires current readiness and allowance, and never resets an uncertain accounting failure", async () => {
    const { generation, children } = await startedGeneration();
    await blockExecution(db, children[0]._id, new ModelBudgetExceeded("managed_platform", startOfDay() + 86400, 1));
    vi.stubEnv("NEWSBEE_MODEL_DAILY_CALLS", "1");
    const key = `model-daily:managed:${new Date().toISOString().slice(0, 10)}`;
    await db.collection("run_budgets").insertOne({ _id: key as never, used: 1 });
    await expect(recoverPublicationGeneration(deps, principal, {
      publicationId, generationId: generation._id, action: "resume",
    })).rejects.toMatchObject({ code: "model_daily_allowance", scope: "managed_platform" });
    expect(await db.collection("run_budgets").findOne({ _id: key as never })).toMatchObject({ used: 1 });
    await blockExecution(db, children[0]._id, new UsageAccountingError("Usage write uncertain; no paid retry."));
    const before = await runJobs(db, children[0]._id);
    await expect(recoverPublicationGeneration(deps, principal, {
      publicationId, generationId: generation._id, action: "retry",
    })).rejects.toMatchObject({ code: "model_usage_accounting_failed" });
    expect(await runJobs(db, children[0]._id)).toEqual(before);
    await db.collection(COLLECTIONS.locations).updateOne({ _id: locations[0].id }, { $set: { "preparation.state": "suspended" } });
    await expect(recoverPublicationGeneration(deps, principal, {
      publicationId, generationId: generation._id, action: "resume",
    })).rejects.toThrow("Invalid generation locations");
  });

  it("retains cancelling admission until executing work settles, fences queued and late workers, and keeps completed results", async () => {
    const { generation, children } = await startedGeneration();
    await seedCompletedChild(children[0], { uniqueTitle: "Keep on cancel", uniqueUrl: "https://example.test/keep" });
    const claimed = (await claim(db, undefined, undefined, children[1]._id))!;
    expect(claimed).toBeTruthy();
    await enqueue(db, { run_id: children[1]._id, location_id: children[1].location_id, kind: "collect_source", dedupe_key: "cancel-pending" });
    expect(await recoverPublicationGeneration(deps, principal, {
      publicationId, generationId: generation._id, action: "cancel",
    })).toMatchObject({ status: "cancelling" });
    await expect(assertGlobalAdmission(db)).rejects.toThrow("unfinished");
    expect(await workableRuns(db)).toEqual([]);
    await db.collection(COLLECTIONS.jobs).updateOne({ _id: claimed._id as never }, { $set: { lease_until: 1 } });
    await recoverExpired(db);
    expect((await runJobs(db, children[1]._id)).find((job) => job._id === claimed._id)?.status).toBe("running");
    await complete(db, claimed, { settled: true });
    expect(await reconcilePublicationGeneration(db, generation._id)).toMatchObject({ status: "cancelled" });
    expect(await runs(db).findOne({ _id: children[0]._id })).toMatchObject({ status: "built" });
    await expect(executeJob(deps, claimed)).rejects.toThrow("Lost job lease");
    expect(await reconcilePublicationGeneration(db, generation._id)).toMatchObject({ status: "cancelled", draft_id: null });
    expect(await db.collection(COLLECTIONS.publicationDrafts).countDocuments()).toBe(0);
    await expect(complete(db, claimed, { late: true })).rejects.toThrow("Lost job lease");
    await expect(assertGlobalAdmission(db)).resolves.toBeUndefined();
  });

  it("does not mistake an expired and requeued claim for a settled worker during cancellation", async () => {
    const { generation, children } = await startedGeneration();
    const claimed = (await claim(db, undefined, undefined, children[0]._id))!;
    let settle!: () => void;
    let admitted!: () => void;
    const gate = new Promise<void>((resolve) => { settle = resolve; });
    const entered = new Promise<void>((resolve) => { admitted = resolve; });
    let dispatched = 0;
    const runtime = await runtimesForRun({
      ...deps,
      transport: async (request) => {
        dispatched += 1;
        admitted();
        await gate;
        return { url: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Completed paid fixture result" }] } }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
        })) };
      },
    }, children[0]);
    const worker = withJobExecution(db, claimed, async () => {
      await expect(runtime.model.generate("fixture")).rejects.toThrow("Lost job lease");
      await expect(assertJobExecutionCurrent()).rejects.toThrow("Lost job lease");
    });
    await entered;
    try {
      await db.collection(COLLECTIONS.jobs).updateOne({ _id: claimed._id as never }, { $set: { lease_until: 1 } });
      await recoverExpired(db);
      expect((await runJobs(db, children[0]._id))[0].status).toBe("pending");
      expect(await recoverPublicationGeneration(deps, principal, {
        publicationId, generationId: generation._id, action: "cancel",
      })).toMatchObject({ status: "cancelling" });
      await expect(assertGlobalAdmission(db)).rejects.toThrow("unfinished");
    } finally {
      settle();
      await worker;
    }
    expect(await reconcilePublicationGeneration(db, generation._id)).toMatchObject({ status: "cancelled", draft_id: null });
    expect(dispatched).toBe(1);
    expect(await db.collection(COLLECTIONS.modelUsage).countDocuments({ run_id: children[0]._id, ok: true })).toBe(1);
  });

  it("requires valid audited Admin support and binds recovery to the target publication", async () => {
    const { generation, children } = await startedGeneration();
    await blockExecution(db, children[0]._id, new Error("Recovery required."));
    const admin: Principal = { id: "support-admin", email: "support@example.test", role: "admin" };
    await db.collection("journalist_admins").insertOne({ principalId: admin.id, email: admin.email, role: admin.role, enabled: true });
    await expect(recoverPublicationGeneration(deps, admin, {
      publicationId, generationId: generation._id, action: "cancel",
    })).rejects.toBeInstanceOf(PublicationAccessDenied);
    await enterPublicationSupport(db, admin, publicationId, "Investigate the blocked publication generation.");
    await expect(recoverPublicationGeneration(deps, admin, {
      publicationId: "foreign-publication", generationId: generation._id, action: "cancel",
    })).rejects.toBeInstanceOf(PublicationAccessDenied);
    await db.collection(COLLECTIONS.publicationGenerations).updateOne({ _id: generation._id as never }, {
      $unset: { preference_snapshot: "" },
    });
    await runs(db).deleteOne({ _id: children[1]._id });
    await db.collection(COLLECTIONS.jobs).deleteMany({ run_id: children[1]._id });
    await expect(recoverPublicationGeneration(deps, admin, {
      publicationId, generationId: generation._id, action: "retry",
    })).rejects.toThrow("Choose the permitted funding explicitly");
    await expect(recoverPublicationGeneration(deps, admin, {
      publicationId, generationId: generation._id, action: "retry", funding: "personal", reason: "Use my own account for deliberate support recovery.",
    })).rejects.toThrow("personal model API key");
    vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify({ fixture: Buffer.alloc(32, 4).toString("base64") }));
    vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "fixture");
    await saveCredentialProfile(db, admin, { source: "personal", config: {
      modelProviders: [{ name: "gemini", kind: "gemini", model: "personal-admin", apiKey: "personal-admin-key" }],
    } });
    expect(await recoverPublicationGeneration(deps, admin, {
      publicationId, generationId: generation._id, action: "retry", funding: "personal", reason: "Use my own account for deliberate support recovery.",
    })).toMatchObject({ status: "running" });
    expect((await db.collection(COLLECTIONS.publicationGenerations).findOne({ _id: generation._id as never }))?.preference_snapshot)
      .toMatchObject({ publication_id: publicationId });
    expect(await runs(db).countDocuments({ publication_generation_id: generation._id })).toBe(2);
    expect(await runs(db).find({ publication_generation_id: generation._id }).toArray())
      .toEqual(expect.arrayContaining([expect.objectContaining({ execution: expect.objectContaining({ source: "personal", sponsorId: admin.id }) })]));
    expect(await recoverPublicationGeneration(deps, admin, {
      publicationId, generationId: generation._id, action: "cancel",
    })).toMatchObject({ status: "cancelled" });
  });

  it("requires deliberate personal funding when an Admin recovers managed work with every child missing", async () => {
    const { generation, children } = await startedGeneration();
    await blockExecution(db, children[0]._id, new Error("Recovery required."));
    const admin: Principal = { id: "support-admin", email: "support@example.test", role: "admin" };
    await db.collection("journalist_admins").insertOne({ principalId: admin.id, email: admin.email, role: admin.role, enabled: true });
    await enterPublicationSupport(db, admin, publicationId, "Recover a generation whose children are missing.");
    vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify({ fixture: Buffer.alloc(32, 4).toString("base64") }));
    vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "fixture");
    await saveCredentialProfile(db, admin, { source: "personal", config: {
      modelProviders: [{ name: "gemini", kind: "gemini", model: "personal-admin", apiKey: "personal-admin-key" }],
    } });
    await runs(db).deleteMany({ publication_generation_id: generation._id });
    await db.collection(COLLECTIONS.jobs).deleteMany({ run_id: { $in: children.map((child) => child._id) } });
    await expect(recoverPublicationGeneration(deps, admin, {
      publicationId, generationId: generation._id, action: "retry",
    })).rejects.toThrow("Choose the permitted funding explicitly");
    expect(await runs(db).countDocuments({ publication_generation_id: generation._id })).toBe(0);
    expect(await recoverPublicationGeneration(deps, admin, {
      publicationId, generationId: generation._id, action: "retry", funding: "personal", reason: "Deliberately fund replacement children from my personal account.",
    })).toMatchObject({ status: "running" });
    expect(await runs(db).find({ publication_generation_id: generation._id }).toArray())
      .toEqual(children.map(() => expect.objectContaining({ execution: expect.objectContaining({ source: "personal", sponsorId: admin.id }) })));
  });

  it("rethrows maintenance 503 without mutating or reconnecting the parent", async () => {
    const { generation, children } = await startedGeneration();
    await blockExecution(db, children[0]._id, new Error("Explicit recovery required."));
    const before = await db.collection(COLLECTIONS.publicationGenerations).findOne({ _id: generation._id as never });
    await db.collection(RESTORE_STATE).updateOne({ _id: "site" as never }, { $set: { phase: "draining" } });
    await expect(recoverPublicationGeneration(deps, principal, {
      publicationId, generationId: generation._id, action: "resume",
    })).rejects.toBeInstanceOf(MaintenanceError);
    await expect(reconcilePublicationGeneration(db, generation._id)).rejects.toMatchObject({ status: 503 });
    expect(await db.collection(COLLECTIONS.publicationGenerations).findOne({ _id: generation._id as never })).toEqual(before);
  });
});
