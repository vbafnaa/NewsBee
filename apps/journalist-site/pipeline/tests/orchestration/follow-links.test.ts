import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { loadSettings } from "../../core/config";
import type { HttpTransport } from "../../core/http";
import { defaultRunOptions } from "../../core/run-options";
import type { SourceTask } from "../../connectors/types";
import { collectedItems, ensureItemIndexes, type CollectedItem } from "../../editions/assemble";
import { collectedItemExpiration, dryRunCollectedItemRetention } from "../../editions/retention";
import { followPageLinks, recollectSource } from "../../orchestration/inspect";
import { ensureJobIndexes } from "../../orchestration/jobs";
import { runOne, type OrchestratorDeps } from "../../orchestration/orchestrator";
import { ensureRunIndexes, getRun, runs } from "../../orchestration/runs";
import { COLLECTIONS } from "../../storage/mongo";

const ROOT = "https://town.example/";
const STORY = `${ROOT}news/2026/11/08/park-reopens`;
const task: SourceTask = { type: "web", source_id: "web:town", name: "Town", params: { url: ROOT } };
const event = (name: string, start: string) => `<html><head><title>${name}</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Event", name, startDate: start,
  url: `${ROOT}events/${name.toLowerCase().replace(/\W+/g, "-")}`, location: { "@type": "Place", name: "City Park" } })}</script></head><body></body></html>`;
const PAGES: Record<string, string> = {
  [ROOT]: `<html><head><title>Town</title></head><body><p>Welcome to Town.</p></body></html>`,
  [STORY]: `<html><head><title>Park reopens | Town</title></head><body><nav><a href="/events/menu-thing">Menu</a></nav><main><p>The park reopens. See <a href="/events/ribbon-cutting">the ribbon cutting</a>.</p></main></body></html>`,
  [`${ROOT}events/ribbon-cutting`]: event("Ribbon Cutting", "2026-11-14T10:00"),
  [`${ROOT}events/menu-thing`]: event("Menu Thing", "2026-11-14T10:00"),
};
const transport: HttpTransport = async (request) => {
  const body = request.url.endsWith("robots.txt") ? "User-agent: *\nAllow: /\n" : PAGES[request.url];
  return { url: request.url, status: body ? 200 : 404, headers: {}, body: new TextEncoder().encode(body ?? "") };
};

let server: MongoMemoryServer, client: MongoClient, db: Db, deps: OrchestratorDeps;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("follow-links"); });
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  await ensureRunIndexes(db);
  await ensureJobIndexes(db);
  deps = { db, settings: loadSettings({ NEWSBEE_MODE: "local" }), transport } as OrchestratorDeps;
  await db.collection(COLLECTIONS.locations).insertOne({ _id: "town" as never, id: "town", name: "Town, WA", state: "WA", systems: [], government: null, community: { name: "Town", newsrooms: [] } });
  await runs(db).insertOne({ _id: "run", kind: "edition", location_id: "town", status: "awaiting_authoring", today: "2026-11-09", window: ["2026-11-09", "2026-11-15"], planned: true,
    collection_tasks: [task], sources: [{ source_id: task.source_id, name: task.name, status: "completed", job_id: null }], options: { ...defaultRunOptions({}), mode: "manual", paid: {}, scrape_depth: 2 },
    stage_transitions: [], created_at: 1, updated_at: 1 } as never);
  await collectedItems(db).insertOne({ _id: "run:web:town:story", run_id: "run", location_id: "town", source_id: task.source_id, source_name: "Town", title: "Park reopens", url: STORY, event_date: "2026-11-08",
    status: "dropped", reason: "undated", step: "reader", facts: null, found: { crawl_depth: 1 }, created_at: 1 } as CollectedItem);
});

const drain = async () => { while (await runOne(deps)) { /* run every queued job */ } };

it("reads an accepted page's links one level deeper, adds what they lead to, and goes back to waiting for authoring", async () => {
  const started = await followPageLinks(db, "run", "run:web:town:story", "editor@example.org");
  expect(started).toMatchObject({ page: STORY, depth: 2 });
  expect((await getRun(db, "run"))?.status).toBe("collecting");
  await drain();

  const added = await collectedItems(db).find({ run_id: "run", followed_from: "run:web:town:story", status: "collected" }).toArray();
  expect(added.map((item) => [item.title, item.followed_by, item.facts?.crawl_depth, item.facts?.found_on])).toEqual([["Ribbon Cutting", "editor@example.org", 2, STORY]]);
  expect(typeof added[0].created_at).toBe("number");
  expect(added[0].retention_expires_at).toBeInstanceOf(Date);
  expect(added[0].retention_expires_at).toEqual(collectedItemExpiration(added[0].created_at));
  await ensureItemIndexes(db);
  expect((await collectedItems(db).indexes()).find((index) => index.name === "collected_item_retention_inventory")).not.toHaveProperty("expireAfterSeconds");
  const inventory = await dryRunCollectedItemRetention(db, { review: {
    complete: true, retainedItemIds: new Set(), retainedRunIds: new Set(["run"]), retainedStoryIds: new Set(),
  } });
  expect(inventory.rows.every((row) => row.action === "retain" && row.reason === "retained_reference")).toBe(true);
  // The page's menu isn't followed, and the accepted story itself is untouched.
  expect(await collectedItems(db).findOne({ run_id: "run", title: "Menu Thing" })).toBeNull();
  expect(await collectedItems(db).findOne({ _id: "run:web:town:story" })).toMatchObject({ status: "dropped", reason: "undated", created_at: 1 });
  expect(await collectedItems(db).findOne({ _id: "run:web:town:story" })).not.toHaveProperty("retention_expires_at");
  const run = await getRun(db, "run");
  expect(run?.status).toBe("awaiting_authoring");
  expect(run?.sources[0].status).toBe("completed");

  // Collecting the source again keeps what the editor found this way.
  await recollectSource(db, "run", task.source_id, "editor@example.org");
  await drain();
  expect(await collectedItems(db).countDocuments({ run_id: "run", followed_from: "run:web:town:story", status: "collected" })).toBe(1);
}, 30_000);

it("follows links only before writing starts, and not while the source is still being collected", async () => {
  await runs(db).updateOne({ _id: "run" }, { $set: { status: "awaiting_finish" } });
  await expect(followPageLinks(db, "run", "run:web:town:story", "editor@example.org")).rejects.toThrow("only before writing starts");
  await runs(db).updateOne({ _id: "run" }, { $set: { status: "collecting", "sources.0.status": "pending" } });
  await expect(followPageLinks(db, "run", "run:web:town:story", "editor@example.org")).rejects.toThrow("still being collected");
});
