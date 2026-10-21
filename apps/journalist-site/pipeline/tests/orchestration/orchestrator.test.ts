/**
 * Integration: trigger -> collect jobs -> per-source shortlist -> barrier -> authoring jobs ->
 * publish to output channels and run artifacts, on real MongoDB semantics with a fake
 * model, fake connectors and the local Drive stand-in.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "../../core/config";
import { logger } from "../../core/log";
import { latestPublished } from "../../editions/authoring";
import { addLocationsToChannel, refreshChannelDirectory } from "../../orchestration/publish";
import { healthSummary, locationHealth } from "../../orchestration/health";
import { readerData } from "../../../../reader-site/src/lib/reader-data";
import { sourceResult, type CollectedEvent, type Connector, type LocationProfile, type SourceType } from "../../connectors/types";
import { acquireWorker, releaseWorker, renewWorker, claim, ensureJobIndexes, MAX_RATE_LIMIT_RETRIES, cancelRunJobs, nextPendingJob, pendingJobs, recentJobs, runJobs } from "../../orchestration/jobs";
import { resumeRun, runOne, startRun, tick, triggerStage } from "../../orchestration/orchestrator";
import { cancelRun, ensureRunIndexes, getRun, oldestActiveRun, RunConflict } from "../../orchestration/runs";
import { diagnoseRuns, expireOverdueRuns } from "../../orchestration/diagnostics";
import { ModelRateLimitError } from "../../model/runtime";
import { LocalArtifacts } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { FakeModel } from "../support/fake-model";
import { withMongo } from "../support/mongo";

const LOCATION = {
  id: "auburn-wa",
  name: "Auburn, WA",
  state: "WA",
  census_geoid: "5303180",
  latitude: 47.3,
  longitude: -122.2,
  directory_edition: null,
  systems: [],
  government: null,
  onboarded_at: "2026-01-01T00:00:00Z",
} as unknown as LocationProfile;

function event(id: string, title: string, day: number): CollectedEvent {
  return {
    source_event_id: id,
    title,
    event_date: `2099-11-0${day}`,
    schedule_text: `November ${day}, 2099`,
    venue: "Town Hall",
    room: null,
    source_url: `https://example.org/${id}`,
    description: "Neighbors discuss practical local resources.",
    kind: "event",
    tier: "local",
    section: null,
  } as unknown as CollectedEvent;
}

type Behaviour = "ok" | "throw" | "flaky";

function fakeConnector(type: SourceType, behaviour: () => Behaviour, events: CollectedEvent[]): Connector {
  let calls = 0;
  return {
    type,
    sources: () => [{ source_id: `${type}:main`, name: `${type} source`, type }],
    async collect(task) {
      calls += 1;
      const mode = behaviour();
      if (mode === "throw" || (mode === "flaky" && calls === 1)) throw new Error(`${type} unavailable`);
      return { result: sourceResult(task.source_id, task.name, "ingested", "ok", { event_count: events.length }), events };
    },
  };
}

function model() {
  return new FakeModel(({ prompt }) => {
    if (prompt.startsWith("Rate each candidate")) {
      const data = JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string }>;
      return { ratings: data.map(({ id }) => ({ id, category: "civic_and_practical", civic: 1, appeal: 0, special: 0 })) };
    }
    if (prompt.startsWith("You write for a friendly local community newsletter.")) {
      const story = JSON.parse(prompt.match(/\nStory:\n(\{[^\n]*\})/)?.[1] ?? "{}") as { title: string };
      return { headline: `${story.title} brings neighbors together`, summary: story.title === "Raffle" ? "Free raffle." : "Neighbors discuss practical local resources." };
    }
    if (prompt.startsWith("You edit a friendly local community newsletter.")) {
      return { headline: "Neighbors gather this week", intro: "Neighbors can explore these community stories." };
    }
    if (prompt.startsWith("You write the email")) return { blurb: "Discover the latest local community stories." };
    throw new Error(`Unexpected prompt: ${prompt.slice(0, 40)}`);
  });
}

describe("orchestrator", () => {
  const mongo = withMongo();
  let dir: string;
  let store: LocalArtifacts;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "newsbee-orch-"));
    store = new LocalArtifacts(dir);
    await mongo.db.collection(COLLECTIONS.locations).insertOne({ ...LOCATION, _id: LOCATION.id as never });
    await mongo.db.collection(COLLECTIONS.outputChannels).insertOne({
      _id: "reader-site" as never, name: "Reader site", enabled: true, drive_folder_id: "channel", selected_location_ids: [LOCATION.id], published_location_ids: [],
    });
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  function deps(behaviours: Partial<Record<SourceType, Behaviour>> = {}) {
    const make = (type: SourceType, events: CollectedEvent[]) => fakeConnector(type, () => behaviours[type] ?? "ok", events);
    return {
      db: mongo.db,
      store,
      settings: loadSettings({ NEWSBEE_ROOT: dir } as unknown as NodeJS.ProcessEnv),
      model: model(),
      connectors: {
        library: make("library", [event("lib-1", "Story Time", 2), event("lib-2", "Raffle", 3)]),
        meetings: make("meetings", [event("mtg-1", "Council Budget Hearing", 4)]),
        hazards: make("hazards", []),
        statenews: make("statenews", []),
        trending: make("trending", []),
        civiccalendar: make("civiccalendar", []),
        homesafety: make("homesafety", []),
        housing: make("housing", []),
        development: make("development", []),
        athletics: make("athletics", []),
      } as Record<SourceType, Connector>,
    };
  }

  /** Explicitly act as an editor at each gate; ticks themselves must never cross one. */
  async function drain(d: ReturnType<typeof deps>) {
    for (let i = 0; i < 20; i += 1) {
      await mongo.db.collection(COLLECTIONS.jobs).updateMany({ status: "pending" }, { $set: { available_at: 0 } });
      const { executed } = await tick(d, { budgetMs: 10_000, concurrency: 3 });
      const waiting = await d.db.collection(COLLECTIONS.runs).find({ status: { $in: ["awaiting_authoring", "awaiting_finish"] } }).toArray();
      for (const run of waiting) await triggerStage(d, String(run._id), run.status === "awaiting_authoring" ? "authoring" : "finish", "test-editor");
      if (waiting.length) continue;
      if (!executed) return;
    }
    throw new Error("Queue did not drain");
  }

  it("requires three editor actions, and repeated ticks never cross either gate", async () => {
    const d = deps();
    const { run } = await startRun(d, LOCATION.id, { by: "collector@example.org", kind: "manual" });
    await expect(triggerStage(d, run._id, "authoring", "editor")).rejects.toBeInstanceOf(RunConflict);
    await expect(triggerStage(d, run._id, "finish", "editor")).rejects.toBeInstanceOf(RunConflict);
    await tick(d, { budgetMs: 10_000 });
    expect((await getRun(d.db, run._id))?.status).toBe("awaiting_authoring");
    expect(d.model.calls).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect(await tick(d)).toEqual({ executed: 0 });
    expect(await oldestActiveRun(d.db)).toBeNull();
    expect(await acquireWorker(d.db)).toBeTypeOf("string");
    await d.db.collection(COLLECTIONS.heartbeat).deleteOne({ _id: "pipeline-worker" as never });
    expect((await runJobs(d.db, run._id)).every((job) => job.kind === "collect_source")).toBe(true);
    await expect(resumeRun(d, run._id, "editor")).rejects.toBeInstanceOf(RunConflict);
    await expect(triggerStage(d, run._id, "finish", "editor")).rejects.toBeInstanceOf(RunConflict);

    await triggerStage(d, run._id, "authoring", "writer@example.org");
    await tick(d, { budgetMs: 10_000 });
    expect((await getRun(d.db, run._id))?.status).toBe("awaiting_finish");
    const calls = d.model.calls.length;
    for (let i = 0; i < 3; i++) expect(await tick(d)).toEqual({ executed: 0 });
    expect(d.model.calls).toHaveLength(calls);
    expect((await runJobs(d.db, run._id)).some((job) => job.kind === "author_finish")).toBe(false);
    expect(await d.db.collection(COLLECTIONS.editionEntries).countDocuments({})).toBeGreaterThan(0);
    expect((await getRun(d.db, run._id))?.published).toBeNull();
    await expect(triggerStage(d, run._id, "authoring", "editor")).rejects.toBeInstanceOf(RunConflict);

    await triggerStage(d, run._id, "finish", "publisher@example.org");
    await tick(d, { budgetMs: 10_000 });
    const done = await getRun(d.db, run._id);
    expect(done?.status).toBe("published");
    expect(done?.stage_transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "collecting", by: "collector@example.org" }),
      expect.objectContaining({ status: "authoring", by: "writer@example.org" }),
      expect.objectContaining({ status: "finishing", by: "publisher@example.org" }),
    ]));
    await expect(triggerStage(d, run._id, "finish", "editor")).rejects.toBeInstanceOf(RunConflict);
    await expect(resumeRun(d, run._id, "editor")).rejects.toBeInstanceOf(RunConflict);
  });

  it.each(["awaiting_authoring", "awaiting_finish"] as const)("does not timeout, stall or block another location while %s", async (gate) => {
    const d = deps();
    const { run } = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    await tick(d, { budgetMs: 10_000 });
    if (gate === "awaiting_finish") {
      await triggerStage(d, run._id, "authoring", "editor");
      await tick(d, { budgetMs: 10_000 });
    }
    await d.db.collection(COLLECTIONS.runs).updateOne({ _id: run._id as never }, { $set: { created_at: 1, stage_started_at: 1, updated_at: 1 } });
    expect(await expireOverdueRuns(d.db, 1)).toEqual([]);
    const waiting = (await getRun(d.db, run._id))!;
    expect((await diagnoseRuns(d.db, [waiting], 1)).get(run._id)).toBeUndefined();
    expect((await locationHealth(d.db, waiting, LOCATION, { runTimeoutSeconds: 1 })).diagnostics).toBeNull();
    await d.db.collection(COLLECTIONS.heartbeat).updateOne({ _id: "scheduler" as never }, { $set: { last_tick_at: 0 } });
    const summary = await healthSummary(d.db, d.model, { runTimeoutSeconds: 1, modelProviders: [] });
    expect(summary.scheduler.status).toBe("stale");
    expect(summary.status).toBe("ok");
    expect(summary.locations[0].stage).toBe(gate);
    expect((await startRun(d, LOCATION.id, { by: "editor", kind: "manual" })).started).toBe(false);
    await d.db.collection(COLLECTIONS.locations).insertOne({ ...LOCATION, id: "kent-wa", _id: "kent-wa" as never });
    const next = await startRun(d, "kent-wa", { by: "editor", kind: "manual" });
    expect((await oldestActiveRun(d.db))?._id).toBe(next.run._id);
    await tick(d, { budgetMs: 10_000 });
    expect((await getRun(d.db, next.run._id))?.status).toBe("awaiting_authoring");
    await triggerStage(d, run._id, gate === "awaiting_authoring" ? "authoring" : "finish", "editor");
    expect(await expireOverdueRuns(d.db, 3600)).toEqual([]);
    expect((await getRun(d.db, run._id))?.stage_started_at).toBeGreaterThan(Date.now() / 1000 - 5);
  });

  it("re-kicks stalled stages concurrently without duplicate jobs or resetting backoff", async () => {
    const d = deps();
    await ensureJobIndexes(d.db);
    const { run } = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    await Promise.all(Array.from({ length: 4 }, () => resumeRun(d, run._id, "editor")));
    expect(await d.db.collection(COLLECTIONS.jobs).countDocuments({ run_id: run._id })).toBe(5);
    await tick(d, { budgetMs: 10_000 });
    await Promise.all(Array.from({ length: 4 }, () => triggerStage(d, run._id, "authoring", "editor")));
    const future = Date.now() / 1000 + 90;
    await d.db.collection(COLLECTIONS.jobs).updateMany({ run_id: run._id, kind: "author_start" }, { $set: { available_at: future } });
    await resumeRun(d, run._id, "editor");
    expect((await runJobs(d.db, run._id)).filter((job) => job.kind === "author_start")).toHaveLength(1);
    expect((await runJobs(d.db, run._id)).find((job) => job.kind === "author_start")?.available_at).toBe(future);
    const started = (await getRun(d.db, run._id))?.stage_started_at;
    await d.db.collection(COLLECTIONS.jobs).updateMany({ run_id: run._id, status: "pending" }, { $set: { available_at: 0 } });
    await runOne(d);
    await resumeRun(d, run._id, "editor");
    expect((await runJobs(d.db, run._id)).filter((job) => job.kind === "author_start")).toHaveLength(1);
    expect((await getRun(d.db, run._id))?.stage_started_at).toBe(started);
    await tick(d, { budgetMs: 10_000 });
    await Promise.all(Array.from({ length: 4 }, () => triggerStage(d, run._id, "finish", "editor")));
    expect((await runJobs(d.db, run._id)).filter((job) => job.kind === "author_finish")).toHaveLength(1);
    await tick(d, { budgetMs: 10_000 });
    expect((await getRun(d.db, run._id))?.status).toBe("published");
  });

  it("repairs a stage transition interrupted before enqueue and ignores an in-progress run with no work", async () => {
    const d = deps();
    const { run } = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    await tick(d, { budgetMs: 10_000 });
    await d.db.collection(COLLECTIONS.runs).updateOne({ _id: run._id as never }, { $set: { status: "authoring" } });
    expect(await oldestActiveRun(d.db)).toBeNull();
    await resumeRun(d, run._id, "editor");
    expect((await oldestActiveRun(d.db))?._id).toBe(run._id);
    await runOne(d);
    // Simulate a crash losing the next queued step after persisting the completed start.
    await d.db.collection(COLLECTIONS.jobs).deleteMany({ run_id: run._id, kind: "author_story" });
    await resumeRun(d, run._id, "editor");
    expect((await runJobs(d.db, run._id)).filter((job) => job.kind === "author_story")).toHaveLength(1);
    await tick(d, { budgetMs: 10_000 });
    expect((await getRun(d.db, run._id))?.status).toBe("awaiting_finish");
  });

  it.each(["awaiting_authoring", "awaiting_finish"] as const)("allows cancel and fresh restart from %s and indexes the gate as open", async (gate) => {
    const d = deps();
    await ensureRunIndexes(d.db);
    const { run } = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    await tick(d, { budgetMs: 10_000 });
    if (gate === "awaiting_finish") {
      await triggerStage(d, run._id, "authoring", "editor");
      await tick(d, { budgetMs: 10_000 });
    }
    await expect(d.db.collection(COLLECTIONS.runs).insertOne({ ...run, _id: randomUUID() as never })).rejects.toMatchObject({ code: 11000 });
    await cancelRun(d.db, run._id, "editor");
    await cancelRunJobs(d.db, run._id);
    expect(await runOne(d)).toBe(false);
    await expect(triggerStage(d, run._id, gate === "awaiting_authoring" ? "authoring" : "finish", "editor")).rejects.toBeInstanceOf(RunConflict);
    const restarted = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    expect(restarted.started).toBe(true);
    expect(restarted.run._id).not.toBe(run._id);
    expect((await getRun(d.db, run._id))?.status).toBe("cancelled");
    await tick(d, { budgetMs: 10_000 });
    expect((await getRun(d.db, restarted.run._id))?.status).toBe("awaiting_authoring");
  });

  it("runs every source, authors once all finish, holds failures and publishes to the channel", async () => {
    const d = deps();
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    expect(run.sources).toHaveLength(5);
    await drain(d);

    const done = await getRun(mongo.db, run._id);
    expect(done?.status).toBe("published");
    expect(done?.sources.every((source) => source.status === "completed")).toBe(true);
    expect(done?.published).toMatchObject({ items: 2, held: 1, channels: ["reader-site"] });
    expect(Object.keys(done?.published?.held_reasons ?? {})).toContain("summary:unsupported_claim_word:free");

    const edition = JSON.parse(await readFile(path.join(dir, "channel", `${done?.edition_id}.json`), "utf8"));
    expect(edition.location_id).toBe(LOCATION.id);
    expect(edition.items).toHaveLength(2);
    const directory = JSON.parse(await readFile(path.join(dir, "channel", "locations.json"), "utf8"));
    expect(directory.locations.map((entry: { id: string }) => entry.id)).toEqual([LOCATION.id]);
    expect(done?.published?.artifacts.email_html).toMatch(/email-previews/);
    const jobs = await recentJobs(mongo.db, 50);
    const sourceJobs = jobs.filter((job) => job.kind === "collect_source");
    expect(sourceJobs).toHaveLength(5);
    for (const job of sourceJobs) {
      expect(job.log_file).toBeTruthy();
      expect(job.log_error).toBeNull();
      const records = (await store.readText(job.log_file!)).trim().split("\n").map((line) => JSON.parse(line) as { event: string });
      expect(records.map((record) => record.event)).toContain("job_started");
      expect(records.map((record) => record.event)).toContain("job_completed");
    }
    expect(jobs.map((job) => job.kind)).toContain("author_finish");
  });
  it("caps hosted candidates at five through both shortlist stages and uses the injected ranking model", async () => {
    const base = deps();
    const libraryEvents = Array.from({ length: 20 }, (_, index) => event(`workshop-${index}`, `Workshop ${String(index).padStart(2, "0")}`, 2));
    const rankingModel = new FakeModel(({ prompt }) => {
      const candidates = JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string; title: string }>;
      return { ratings: candidates.map(({ id, title }) => ({ id, category: "other", civic: title === "Workshop 04" ? 3 : 0, appeal: 0, special: 0 })) };
    });
    const d = { ...base,
      settings: loadSettings({ ...process.env, NEWSBEE_ROOT: dir, NEWSBEE_MODEL_PROVIDERS: "gemini" }),
      rankingModel,
      connectors: { ...base.connectors, library: fakeConnector("library", () => "ok", libraryEvents) },
    };
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    await drain(d);
    const source = (await getRun(mongo.db, run._id))?.sources.find(({ source_id }) => source_id === "library:main");
    expect(source).toMatchObject({ event_count: 20, shortlisted: 5 });
    const draft = await mongo.db.collection(COLLECTIONS.editions).findOne({ run_id: run._id });
    expect(draft?.source_summary.library).toMatchObject({ considered: 5, shortlisted: 5 });
    expect(draft?.ranking).toMatchObject({ provider: "fake", preselection_limit: 5, candidates: 6, fallback_ratings: 0 });
    expect(draft?.candidates[0].title).toBe("Workshop 04");
    const edition = await latestPublished({ db: d.db, settings: d.settings, model: d.model, log: logger("test") }, LOCATION.id);
    expect(edition?.items.some(({ headline }) => headline.startsWith("Workshop 04"))).toBe(true);
    expect(rankingModel.calls).toHaveLength(1);
    expect(base.model.calls.some(({ prompt }) => prompt.startsWith("Rate each candidate"))).toBe(false);
  });

  it("serializes locations even across overlapping ticks and holds the oldest run during backoff", async () => {
    const d = deps();
    await mongo.db.collection(COLLECTIONS.locations).insertOne({ ...LOCATION, id: "kent-wa", _id: "kent-wa" as never, name: "Kent, WA" });
    const first = await startRun(d, LOCATION.id, { by: "test", kind: "all" });
    await mongo.db.collection(COLLECTIONS.runs).updateOne({ _id: first.run._id as never }, { $set: { created_at: Date.now() / 1000 - 60 } });
    const second = await startRun(d, "kent-wa", { by: "test", kind: "all" });
    await mongo.db.collection(COLLECTIONS.jobs).updateMany({ run_id: first.run._id }, { $set: { available_at: Date.now() / 1000 + 60 } });
    expect(await runOne(d)).toBe(false);
    expect(await runOne(d, { jobId: second.run.sources[0].job_id!, kinds: ["collect_source"] })).toBe(false);
    expect(await pendingJobs(d.db, "collect_source", 1, first.run._id)).toEqual([]);
    expect((await nextPendingJob(d.db, first.run._id))?.available_at).toBeGreaterThan(Date.now() / 1000 + 50);
    expect((await recentJobs(d.db, 50)).filter(({ run_id }) => run_id === second.run._id).every(({ attempts }) => attempts === 0)).toBe(true);
    await mongo.db.collection(COLLECTIONS.jobs).updateMany({ run_id: first.run._id }, { $set: { available_at: 0 } });
    let unblock!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const collect = d.connectors.library.collect;
    d.connectors.library.collect = async (...args) => { entered(); await gate; return collect(...args); };
    // Explicitly choose this connector as the next job, so the second scheduler meets a live lease.
    await mongo.db.collection(COLLECTIONS.jobs).updateOne({ run_id: first.run._id, "payload.task.type": "library" }, { $set: { created_at: 0 } });
    const running = runOne(d);
    await started;
    expect(await runOne(d)).toBe(false);
    unblock();
    await running;
    for (let i = 0; i < 50; i++) {
      if (!await runOne(d)) break;
    }
    expect((await getRun(d.db, first.run._id))?.status).toBe("awaiting_authoring");
    expect((await getRun(d.db, second.run._id))?.status).toBe("awaiting_authoring");
    await drain(d);
    expect((await getRun(d.db, second.run._id))?.status).toBe("published");
  });

  it("defers ranking, prose, front and email 429s without holding or publishing, then resumes", async () => {
    for (const stage of ["ranking", "prose", "front", "email"]) {
      const d = deps();
      const normal = d.model;
      let blocked = true;
      const prefix = { ranking: "Rate each candidate", prose: "You write for a friendly", front: "You edit a friendly", email: "You write the email" }[stage]!;
      d.model = new FakeModel(async ({ prompt }) => {
        if (blocked && prompt.startsWith(prefix)) throw new ModelRateLimitError("TPM exceeded", 90);
        return JSON.parse((await normal.generateStructured(prompt, {})).response);
      });
      const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
      await tick(d, { budgetMs: 10_000 });
      await triggerStage(d, run._id, "authoring", "test-editor");
      await tick(d, { budgetMs: 10_000 });
      if (stage === "front" || stage === "email") {
        await triggerStage(d, run._id, "finish", "test-editor");
        await tick(d, { budgetMs: 10_000 });
      }
      expect((await getRun(d.db, run._id))?.status).toBe(stage === "front" || stage === "email" ? "finishing" : "authoring");
      const pending = await d.db.collection(COLLECTIONS.jobs).findOne({ run_id: run._id, status: "pending", rate_limit_retries: 1 });
      expect(pending).not.toBeNull();
      expect(pending!.available_at).toBeGreaterThan(Date.now() / 1000 + 80);
      expect(await d.db.collection(COLLECTIONS.editionEntries).countDocuments({ edition_id: run._id, "result.error": /TPM/ })).toBe(0);
      expect((await startRun(d, LOCATION.id, { by: "test", kind: "manual" })).started).toBe(false);
      blocked = false;
      await drain(d);
      expect((await getRun(d.db, run._id))?.published?.items).toBe(2);
    }
  });

  it("fails a persistently rate-limited run after bounded backoff instead of replacing the previous edition", async () => {
    const d = deps();
    const previous = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    await drain(d);
    d.model = new FakeModel(() => { throw new ModelRateLimitError("Daily quota exhausted"); });
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    await tick(d, { budgetMs: 10_000 });
    await triggerStage(d, run._id, "authoring", "test-editor");
    await tick(d, { budgetMs: 10_000 });
    for (let retry = 1; retry <= MAX_RATE_LIMIT_RETRIES; retry++) {
      const pending = await d.db.collection(COLLECTIONS.jobs).findOne({ run_id: run._id, status: "pending" });
      expect(pending?.rate_limit_retries).toBe(retry);
      expect(pending?.available_at).toBeGreaterThan(Date.now() / 1000 + Math.min(15 * 2 ** (retry - 1), 300) - 2);
      await d.db.collection(COLLECTIONS.jobs).updateMany({ run_id: run._id, status: "pending" }, { $set: { available_at: 0 } });
      await tick(d, { budgetMs: 10_000 });
    }
    expect((await getRun(d.db, run._id))?.status).toBe("failed");
    expect((await latestPublished({ db: d.db, settings: d.settings, model: d.model, log: logger("test") }, LOCATION.id))?.id).toBe(previous.run._id);
  });

  it("renews both leases and recovers an expired worker without releasing another owner's lease", async () => {
    const d = deps();
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    const token = await acquireWorker(d.db);
    expect(token).toBeTypeOf("string");
    const job = await claim(d.db, undefined, undefined, run._id);
    expect(job).not.toBeNull();
    await renewWorker(d.db, token!, job!);
    expect((await d.db.collection(COLLECTIONS.jobs).findOne({ _id: job!._id as never }))?.lease_until).toBeGreaterThan(Date.now() / 1000 + 300);
    expect(await acquireWorker(d.db)).toBeNull();
    await d.db.collection(COLLECTIONS.heartbeat).updateOne({ _id: "pipeline-worker" as never }, { $set: { lease_until: 0 } });
    const replacement = await acquireWorker(d.db);
    expect(replacement).toBeTypeOf("string");
    await releaseWorker(d.db, token!);
    expect(await acquireWorker(d.db)).toBeNull();
    await expect(renewWorker(d.db, token!, job!)).rejects.toThrow("Lost pipeline worker lease");
    await releaseWorker(d.db, replacement!);
    expect(await acquireWorker(d.db)).toBeTypeOf("string");
  });

  it("fails explicitly for an excessive provider wait instead of retrying sooner than instructed", async () => {
    const d = deps();
    d.model = new FakeModel(() => { throw new ModelRateLimitError("daily quota", 86400); });
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    await tick(d, { budgetMs: 10_000 });
    await triggerStage(d, run._id, "authoring", "test-editor");
    await tick(d, { budgetMs: 10_000 });
    expect((await getRun(d.db, run._id))?.status).toBe("failed");
    expect((await getRun(d.db, run._id))?.edition_id).toBeNull();
  });

  it("keeps the previous edition when front or email quota waits exceed the retry limit", async () => {
    for (const prefix of ["You edit a friendly", "You write the email"]) {
      const d = deps();
      const previous = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
      await drain(d);
      const normal = d.model;
      d.model = new FakeModel(async ({ prompt }) => {
        if (prompt.startsWith(prefix)) throw new ModelRateLimitError("daily quota", 86400);
        return JSON.parse((await normal.generateStructured(prompt, {})).response);
      });
      const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
      await drain(d);
      expect((await getRun(d.db, run._id))?.status).toBe("failed");
      expect((await latestPublished({ db: d.db, settings: d.settings, model: d.model, log: logger("test") }, LOCATION.id))?.id).toBe(previous.run._id);
    }
  });

  it("still publishes when a source fails every attempt, and records why", async () => {
    const d = deps({ meetings: "throw" });
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    await drain(d);
    const done = await getRun(mongo.db, run._id);
    expect(done?.status).toBe("published");
    expect(done?.sources.find((source) => source.type === "meetings")).toMatchObject({ status: "failed", error: "meetings unavailable" });
    expect(done?.published?.items).toBe(1);
    const failedJob = (await recentJobs(mongo.db, 50)).find((job) => job.kind === "collect_source" && job.error);
    expect(failedJob?.log_file).toBeTruthy();
    const attempts = (await store.readText(failedJob!.log_file!)).trim().split("\n").map((line) => JSON.parse(line) as { event: string });
    expect(attempts.filter((record) => record.event === "job_execution_failed")).toHaveLength(3);
  });

  it("retries a transient connector failure", async () => {
    const d = deps({ library: "flaky" });
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    await drain(d);
    const done = await getRun(mongo.db, run._id);
    expect(done?.status).toBe("published");
    expect(done?.sources.find((source) => source.type === "library")?.status).toBe("completed");
  });

  it("does not start a second run while one is collecting", async () => {
    const d = deps();
    const first = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    const second = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    expect(second.started).toBe(false);
    expect(second.run._id).toBe(first.run._id);
  });

  it("claims only the requested source job", async () => {
    const d = deps();
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    const target = run.sources[0].job_id!;
    expect(await runOne(d, { jobId: target, kinds: ["collect_source"] })).toBe(true);
    const jobs = await recentJobs(mongo.db, 50);
    expect(jobs.find((job) => job._id === target)?.status).toBe("completed");
    expect(jobs.filter((job) => job.kind === "collect_source" && job.status === "completed")).toHaveLength(1);
  });

  it("cancels queued jobs, keeps the old attempt, and starts a fresh run", async () => {
    const d = deps();
    const { run } = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    const cancelled = await cancelRun(d.db, run._id, "editor");
    await cancelRunJobs(d.db, run._id);
    expect(cancelled).toMatchObject({ status: "cancelled", error: "Cancelled by editor" });
    expect((await runJobs(d.db, run._id)).every((job) => job.status === "cancelled")).toBe(true);
    await drain(d);
    expect((await getRun(d.db, run._id))?.status).toBe("cancelled");
    expect(await d.db.collection(COLLECTIONS.editions).countDocuments({ run_id: run._id })).toBe(0);

    const restarted = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    expect(restarted.started).toBe(true);
    expect(restarted.run._id).not.toBe(run._id);
    await drain(d);
    expect((await getRun(d.db, restarted.run._id))?.status).toBe("published");
    expect((await getRun(d.db, run._id))?.status).toBe("cancelled");
  });

  it("does not let an in-flight collection advance a cancelled run", async () => {
    const d = deps();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    d.connectors.library.collect = async (task) => {
      entered();
      await blocked;
      return { result: sourceResult(task.source_id, task.name, "ingested", "ok"), events: [] };
    };
    const { run } = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    const worker = runOne(d);
    await started;
    await cancelRun(d.db, run._id, "editor");
    await cancelRunJobs(d.db, run._id);
    expect((await runJobs(d.db, run._id)).some((job) => job.status === "running")).toBe(true);
    release();
    await worker;
    await drain(d);
    expect((await runJobs(d.db, run._id)).every((job) => job.status === "cancelled")).toBe(true);
    expect((await getRun(d.db, run._id))?.status).toBe("cancelled");
    expect(await d.db.collection(COLLECTIONS.editions).countDocuments({ run_id: run._id })).toBe(0);
  });

  it("blocks overlapping authoring and refuses cancellation after publishing starts", async () => {
    const d = deps();
    const { run } = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    await d.db.collection(COLLECTIONS.runs).updateOne({ _id: run._id as never }, { $set: { status: "authoring" } });
    const duplicate = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    expect(duplicate).toMatchObject({ started: false, run: { _id: run._id } });
    await d.db.collection(COLLECTIONS.runs).updateOne({ _id: run._id as never }, { $set: { status: "publishing" } });
    await expect(cancelRun(d.db, run._id, "editor")).rejects.toBeInstanceOf(RunConflict);
  });

  it("migrates the run index and enforces one active attempt per location", async () => {
    const collection = mongo.db.collection(COLLECTIONS.runs);
    await collection.createIndex({ location_id: 1 }, { unique: true, name: "one_collecting_run_per_location", partialFilterExpression: { status: "collecting" } });
    await ensureRunIndexes(mongo.db);
    expect((await collection.indexes()).map((index) => index.name)).toContain("one_open_run_per_location");
    expect((await collection.indexes()).map((index) => index.name)).not.toContain("one_collecting_run_per_location");
    const d = deps();
    const { run } = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    await collection.updateOne({ _id: run._id as never }, { $set: { status: "authoring" } });
    await expect(collection.insertOne({ ...run, _id: "overlap" as never })).rejects.toMatchObject({ code: 11000 });
  });

  it("upgrades the existing active-stage index to protect editor-waiting runs too", async () => {
    const d = deps();
    const collection = mongo.db.collection(COLLECTIONS.runs);
    await collection.createIndex({ location_id: 1 }, {
      unique: true, name: "one_active_run_per_location",
      partialFilterExpression: { status: { $in: ["collecting", "authoring", "publishing"] } },
    });
    const { run } = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    await tick(d, { budgetMs: 10_000 });
    await ensureRunIndexes(d.db);
    const names = (await collection.indexes()).map((index) => index.name);
    expect(names).toContain("one_open_run_per_location");
    expect(names).not.toContain("one_active_run_per_location");
    await expect(collection.insertOne({ ...run, _id: randomUUID() as never })).rejects.toMatchObject({ code: 11000 });
    await ensureRunIndexes(d.db);
    expect((await getRun(d.db, run._id))?.status).toBe("awaiting_authoring");
  });

  it("reconciles legacy overlaps without deleting run IDs or interrupting the furthest attempt", async () => {
    const d = deps();
    const collection = mongo.db.collection(COLLECTIONS.runs);
    await collection.createIndex({ location_id: 1 }, { unique: true, name: "one_collecting_run_per_location", partialFilterExpression: { status: "collecting" } });
    const first = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    await collection.updateOne({ _id: first.run._id as never }, { $set: { status: "authoring" } });
    const newer = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    // startRun now checks every active stage, but legacy deployments allowed the second insert.
    expect(newer.started).toBe(false);
    const overlap = { ...first.run, _id: randomUUID() as never, status: "collecting", created_at: first.run.created_at + 1 };
    await collection.insertOne(overlap);
    await mongo.db.collection(COLLECTIONS.jobs).insertOne({
      _id: randomUUID(), run_id: overlap._id, location_id: LOCATION.id, kind: "collect_source",
      status: "pending", available_at: 0, created_at: 0, dedupe_key: `legacy:${overlap._id}`, payload: {},
    });

    await ensureRunIndexes(d.db);
    expect((await getRun(d.db, first.run._id))?.status).toBe("authoring");
    expect((await getRun(d.db, overlap._id))?.status).toBe("cancelled");
    expect((await getRun(d.db, overlap._id))?.error).toContain(first.run._id);
    expect((await runJobs(d.db, overlap._id))[0].status).toBe("cancelled");
    expect(await collection.countDocuments({ location_id: LOCATION.id })).toBe(2);
    expect((await collection.indexes()).map((index) => index.name)).toContain("one_open_run_per_location");
    await ensureRunIndexes(d.db); // safe across repeated cold starts
  });

  it("keeps concurrent publication attempts intact until their Drive writes finish", async () => {
    const d = deps();
    const collection = mongo.db.collection(COLLECTIONS.runs);
    const { run } = await startRun(d, LOCATION.id, { by: "editor", kind: "manual" });
    await collection.updateOne({ _id: run._id as never }, { $set: { status: "publishing" } });
    const otherRunId = randomUUID();
    await collection.insertOne({ ...run, _id: otherRunId as never, status: "publishing" });
    await ensureRunIndexes(d.db);
    expect((await getRun(d.db, run._id))?.status).toBe("publishing");
    expect((await getRun(d.db, otherRunId))?.status).toBe("publishing");
    expect((await collection.indexes()).map((index) => index.name)).not.toContain("one_open_run_per_location");
    await collection.updateOne({ _id: otherRunId as never }, { $set: { status: "published" } });
    await ensureRunIndexes(d.db);
    expect((await collection.indexes()).map((index) => index.name)).toContain("one_open_run_per_location");
  });

  it("shows a connector-reported failure in health even when its job completes", async () => {
    const d = deps();
    d.connectors.meetings.collect = async (task) => ({
      result: sourceResult(task.source_id, task.name, "failed", "Feed unavailable"),
      events: [],
    });
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    await drain(d);
    const done = await getRun(mongo.db, run._id);
    const health = await locationHealth(mongo.db, done, LOCATION);
    expect(health.level).toBe("warning");
    expect(health.sources).toMatchObject({ total: 5, completed: 4, failed: 1 });
    expect(health.failed_sources).toContainEqual({ source_id: "meetings:main", name: "meetings source", error: "Feed unavailable" });
    expect(health.empty_sources.map((source) => source.source_id)).not.toContain("meetings:main");
  });

  it("keeps the reader available after a published location is deselected", async () => {
    const d = deps();
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    await drain(d);
    const done = await getRun(mongo.db, run._id);
    await mongo.db.collection(COLLECTIONS.outputChannels).updateOne({ _id: "reader-site" as never }, { $set: { selected_location_ids: [] } });
    await refreshChannelDirectory(d.db, store, "reader-site");
    const oldRoot = process.env.NEWSBEE_LOCAL_DRIVE_DIR;
    const oldMode = process.env.NEWSBEE_MODE;
    process.env.NEWSBEE_LOCAL_DRIVE_DIR = dir;
    process.env.NEWSBEE_MODE = "local";
    try {
      expect((await readerData("channel")).locations).toEqual([]);
      expect((await readerData("channel")).editions).toEqual([]);
      expect(JSON.parse(await readFile(path.join(dir, "channel", `${done?.edition_id}.json`), "utf8")).location_id).toBe(LOCATION.id);
    } finally {
      if (oldRoot === undefined) delete process.env.NEWSBEE_LOCAL_DRIVE_DIR;
      else process.env.NEWSBEE_LOCAL_DRIVE_DIR = oldRoot;
      if (oldMode === undefined) delete process.env.NEWSBEE_MODE;
      else process.env.NEWSBEE_MODE = oldMode;
    }
  });

  it("copies the latest edition into a channel when its location is newly selected", async () => {
    const d = deps();
    await mongo.db.collection(COLLECTIONS.outputChannels).updateOne({ _id: "reader-site" as never }, { $set: { selected_location_ids: [] } });
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    await drain(d);
    const done = await getRun(mongo.db, run._id);
    expect(done?.published?.channels).toEqual([]);

    await mongo.db.collection(COLLECTIONS.outputChannels).updateOne({ _id: "reader-site" as never }, { $set: { selected_location_ids: [LOCATION.id] } });
    const authoring = { db: d.db, model: d.model, settings: d.settings, log: logger("test") };
    const copied = await addLocationsToChannel(d.db, store, "reader-site", [LOCATION.id], (id) => latestPublished(authoring, id));
    expect(copied).toEqual([LOCATION.id]);

    const edition = JSON.parse(await readFile(path.join(dir, "channel", `${done?.edition_id}.json`), "utf8"));
    expect(edition.items).toHaveLength(2);
    const directory = JSON.parse(await readFile(path.join(dir, "channel", "locations.json"), "utf8"));
    expect(directory.locations.map((location: { id: string }) => location.id)).toEqual([LOCATION.id]);
  });
});
