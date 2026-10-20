/**
 * Integration: trigger -> collect jobs -> per-source shortlist -> barrier -> authoring jobs ->
 * publish to output channels and run artifacts, on real MongoDB semantics with a fake
 * model, fake connectors and the local Drive stand-in.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "../../core/config";
import { logger } from "../../core/log";
import { latestPublished } from "../../editions/authoring";
import { addLocationsToChannel, refreshChannelDirectory } from "../../orchestration/publish";
import { locationHealth } from "../../orchestration/health";
import { readerData } from "../../../../reader-site/src/lib/reader-data";
import { sourceResult, type CollectedEvent, type Connector, type LocationProfile, type SourceType } from "../../connectors/types";
import { recentJobs } from "../../orchestration/jobs";
import { startRun, tick } from "../../orchestration/orchestrator";
import { getRun } from "../../orchestration/runs";
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
      } as Record<SourceType, Connector>,
    };
  }

  /** Tick until idle, making retry backoffs due immediately. */
  async function drain(d: ReturnType<typeof deps>) {
    for (let i = 0; i < 20; i += 1) {
      await mongo.db.collection(COLLECTIONS.jobs).updateMany({ status: "pending" }, { $set: { available_at: 0 } });
      const { executed } = await tick(d, { budgetMs: 10_000, concurrency: 3 });
      if (!executed) return;
    }
    throw new Error("Queue did not drain");
  }

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
    const kinds = (await recentJobs(mongo.db, 50)).map((job) => job.kind);
    expect(kinds.filter((kind) => kind === "collect_source")).toHaveLength(5);
    expect(kinds).toContain("author_finish");
  });

  it("still publishes when a source fails every attempt, and records why", async () => {
    const d = deps({ meetings: "throw" });
    const { run } = await startRun(d, LOCATION.id, { by: "test", kind: "manual" });
    await drain(d);
    const done = await getRun(mongo.db, run._id);
    expect(done?.status).toBe("published");
    expect(done?.sources.find((source) => source.type === "meetings")).toMatchObject({ status: "failed", error: "meetings unavailable" });
    expect(done?.published?.items).toBe(1);
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
