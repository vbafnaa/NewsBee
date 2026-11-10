import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { internalToken } from "../../../lib/internal-access";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), headers: vi.fn(), cookies: vi.fn(), deps: vi.fn(), database: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth, isAdminEmail: vi.fn(), getMongoDatabase: mocks.database }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: mocks.deps }));
vi.mock("@/pipeline/storage/mongo", async (original) => ({ ...await original<object>(), getDatabase: mocks.database }));
vi.mock("@/lib/pipeline-queue", () => ({ queueNextJob: vi.fn() }));
vi.mock("@/lib/job-chain", () => ({ callNextJob: vi.fn() }));
vi.mock("../../connectors/web", async (original) => ({ ...await original<object>(), webConnector: { collect: async () => ({ result: { status: "ingested", detail: "ok" }, events: [] }) } }));

import { GET, PATCH } from "../../../app/api/admin/locations/[locationId]/source-map/route";
import { GET as mapGet } from "../../../app/api/maps/locations/[locationId]/source-map/route";
import { GET as allMapGet } from "../../../app/api/maps/source-map/route";
import { COLLECTIONS } from "../../storage/mongo";
import { removeLocationRecords } from "../../communities/locations";
import { displayStatus, liveStatus, NON_SCRAPABLE, nonScrapableReason, statusCounts, UNKNOWN_REASON } from "../../sourcemap/display";
import { decisionOf, OTHER_CODES, reasonLabel, REASONS } from "../../sourcemap/reasons";
import { addSourceLink, InvalidSourceLink } from "../../connectors/manual-links";
import { loadSettings } from "../../core/config";
import {
  collectableSources, emptyHealth, MAX_REVIEW_REASON, recordSourceRun, removeLocationSources, saveSourceReview, setSourceStatus, sourceMap,
  SOURCE_REVIEWS, upsertCandidates, webSourceId, type SourceCandidate, type SourceRecord, type SourceReviewEntry, type SourceStatus,
} from "../../sourcemap/store";

const locationId = "fixture-town-wa";
const password = "test-only-password-not-a-deployment-secret";
const host = "workspace.example.test";
const context = { params: Promise.resolve({ locationId }) };
const today = "2026-11-06";

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("source_labels_test");
}, 60_000);
beforeEach(async () => {
  await db.dropDatabase();
  mocks.auth.mockResolvedValue({ user: { email: "labeller@example.test" } });
  mocks.headers.mockResolvedValue(new Headers({ host }));
  mocks.cookies.mockResolvedValue({ get: () => undefined });
  mocks.database.mockResolvedValue(db);
  mocks.deps.mockResolvedValue({ db });
  await db.collection("journalist_admins").insertOne({ email: "labeller@example.test", enabled: true });
  await db.collection<{ _id: string }>(COLLECTIONS.locations).insertOne({ _id: locationId, id: locationId, name: "Fixture Town", state: "WA", systems: [] } as never);
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

function candidate(sourceId: string, overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    source_id: sourceId, name: `Source ${sourceId}`, url: `https://${sourceId}.example.test/news`, reader: "web", params: {}, section: "news", inside_area: true,
    found_by: { method: "agent", detail: "Found on a search", query: "fixture town news" }, source_tier: "local_reporting", scope: "city", source_kind: "feed", ...overrides,
  };
}
async function seed(sourceId: string, status: SourceStatus = "active") {
  await upsertCandidates(db, locationId, [candidate(sourceId, { status })]);
}
const record = async (sourceId: string) => (await sourceMap(db).findOne({ _id: `${locationId}:${sourceId}` })) as SourceRecord;
const history = (sourceId: string) => db.collection<SourceReviewEntry>(SOURCE_REVIEWS).find({ source_id: sourceId }).sort({ _id: 1 }).toArray();
const label = (sourceId: string, change: Parameters<typeof saveSourceReview>[3]) => saveSourceReview(db, locationId, sourceId, change, "labeller@example.test");
const patch = (body: unknown, headers: Record<string, string> = { origin: `https://${host}` }) =>
  PATCH(new Request(`https://${host}/api/admin/locations/${locationId}/source-map`, { method: "PATCH", headers, body: JSON.stringify(body) }), context);
const emptyRun = { status: "ingested", detail: null, found: 0, local: 0, newestDay: null, today };
const failedRun = { ...emptyRun, status: "failed", detail: "HTTP 500" };

describe("labelling a source", () => {
  it("rejects, accepts and clears, keeping the initial status from the first label", async () => {
    await seed("a", "proposed");
    await label("a", { decision: "reject" });
    expect(await record("a")).toMatchObject({ status: "rejected", review: { decision: "reject", initial_status: "proposed", by: "labeller@example.test" } });
    await label("a", { decision: "accept" });
    expect(await record("a")).toMatchObject({ status: "active", review: { decision: "accept", initial_status: "proposed" } });
    await label("a", { decision: null });
    expect(await record("a")).toMatchObject({ status: "proposed", review: { decision: null, initial_status: "proposed" } });
    expect((await collectableSources(db, locationId, today)).map((source) => source.source_id)).toEqual([]);
  });

  it("feeds accept and reject through to collection", async () => {
    await seed("promoted", "proposed");
    await seed("dropped");
    await label("promoted", { decision: "accept" });
    await label("dropped", { decision: "reject" });
    expect((await collectableSources(db, locationId, today)).map((source) => source.source_id)).toEqual(["promoted"]);
  });

  it("keeps a pinned source pinned, even when accepted after a mistaken reject", async () => {
    await seed("p", "pinned");
    await label("p", { decision: "accept" });
    expect((await record("p")).status).toBe("pinned");
    await label("p", { decision: "reject" });
    expect((await record("p")).status).toBe("rejected");
    await label("p", { decision: "accept" });
    expect((await record("p")).status).toBe("pinned");
  });

  it("with no Pin, Pause or Activate buttons, the Decision alone decides what runs collect", async () => {
    // Paused (for example from a failing source's alert): Accept reads it again.
    await seed("q", "paused");
    expect((await collectableSources(db, locationId, today)).map((source) => source.source_id)).toEqual([]);
    await label("q", { decision: "accept" });
    expect((await record("q")).status).toBe("active");
    expect((await collectableSources(db, locationId, today)).map((source) => source.source_id)).toEqual(["q"]);
    // Accepted and then paused from its alert: clearing and accepting again reads it, as the Decision cell says.
    expect((await patch({ source_id: "q", status: "paused" })).status).toBe(200);
    expect((await collectableSources(db, locationId, today)).map((source) => source.source_id)).toEqual([]);
    await label("q", { decision: null });
    await label("q", { decision: "accept" });
    expect((await collectableSources(db, locationId, today)).map((source) => source.source_id)).toEqual(["q"]);
    // Pinned stays pinned and collected through Accept; Reject stops collection.
    await seed("k", "pinned");
    await label("k", { decision: "accept" });
    expect((await record("k")).status).toBe("pinned");
    await label("k", { decision: "reject" });
    expect((await collectableSources(db, locationId, today)).map((source) => source.source_id)).toEqual(["q"]);
  });

  it("saves a reason without touching the status, before or after a decision", async () => {
    await seed("r", "paused");
    await label("r", { reason: "Looks like a press release mirror" });
    expect(await record("r")).toMatchObject({ status: "paused", review: { decision: null, reason: "Looks like a press release mirror", initial_status: "paused" } });
    await label("r", { decision: "reject" });
    expect((await record("r")).review).toMatchObject({ decision: "reject", reason: "Looks like a press release mirror", initial_status: "paused" });
    await label("r", { decision: null });
    expect(await record("r")).toMatchObject({ status: "paused", review: { decision: null, reason: "Looks like a press release mirror" } });
  });

  it("does not lose either field when a reason and a decision are saved together", async () => {
    await seed("c");
    await Promise.all([label("c", { reason: "Paywalled" }), label("c", { decision: "reject" })]);
    expect((await record("c")).review).toMatchObject({ decision: "reject", reason: "Paywalled", initial_status: "active" });
  });

  it("stores text that looks like a database expression as plain text", async () => {
    await seed("t");
    await label("t", { reason: "$status" });
    expect((await record("t")).review?.reason).toBe("$status");
  });

  it("appends a full snapshot for every change", async () => {
    await seed("h", "proposed");
    await label("h", { decision: "reject" });
    await label("h", { reason: "Not local" });
    await label("h", { decision: null });
    const rows = await history("h");
    expect(rows.map((row) => [row.decision, row.reason, row.status])).toEqual([["reject", null, "rejected"], ["reject", "Not local", "rejected"], [null, "Not local", "proposed"]]);
    expect(rows[1]).toMatchObject({
      location_id: locationId, source_id: "h", url: "https://h.example.test/news", name: "Source h", section: "news", source_tier: "local_reporting", scope: "city", source_kind: "feed",
      found_by: { method: "agent", query: "fixture town news" }, initial_status: "proposed", by: "labeller@example.test",
    });
    expect(rows[1].at).toEqual(expect.any(String));
  });

  it("fails clearly for an unknown source and writes no history", async () => {
    await expect(label("missing", { decision: "accept" })).rejects.toThrow("Unknown source");
    expect(await history("missing")).toEqual([]);
  });
});

describe("reason codes", () => {
  const codes = (decision: "accept" | "reject") => REASONS[decision].map((reason) => reason.code);

  it("keeps one list, with an Other in each decision", () => {
    expect(codes("accept")).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
    expect(codes("reject")).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"]);
    expect(OTHER_CODES.map(reasonLabel)).toEqual(["Other (explain)", "Other (explain)"]);
    expect([decisionOf("A1"), decisionOf("R1"), decisionOf("A7")]).toEqual(["accept", "reject", null]);
  });

  it("saves a code without touching the status, and records it in the history as shown", async () => {
    await seed("a");
    await patch({ source_id: "a", decision: "reject" });
    expect((await patch({ source_id: "a", reason_code: "R4" })).status).toBe(200);
    expect(await record("a")).toMatchObject({ status: "rejected", review: { decision: "reject", reason_code: "R4", reason: null } });
    expect((await history("a")).at(-1)).toMatchObject({ reason_code: "R4", reason_label: "Duplicate of a source already on the map", reason: null });
  });

  it("refuses a code that doesn't belong to the decision, and writes no history", async () => {
    await seed("a");
    expect((await patch({ source_id: "a", reason_code: "A1" })).status).toBe(400);
    await patch({ source_id: "a", decision: "accept" });
    for (const body of [{ reason_code: "R1" }, { reason_code: "Z9" }, { reason_code: 1 }, { decision: "reject", reason_code: "A1" }, { decision: null, reason_code: "A1" }]) {
      expect((await patch({ source_id: "a", ...body })).status).toBe(400);
    }
    expect((await record("a")).review).toMatchObject({ decision: "accept", reason_code: null });
    expect(await history("a")).toHaveLength(1);
    expect((await patch({ source_id: "missing", reason_code: "A1" })).status).toBe(404);
  });

  it("refuses Other text without an Other code", async () => {
    await seed("a");
    await patch({ source_id: "a", decision: "accept" });
    await patch({ source_id: "a", reason_code: "A1" });
    expect((await patch({ source_id: "a", reason: "Text alone" })).status).toBe(400);
    expect((await patch({ source_id: "a", reason_code: "A2", reason: "Text" })).status).toBe(400);
    expect((await record("a")).review).toMatchObject({ reason_code: "A1", reason: null });
  });

  it("saves Other with or without its text, and the history keeps the text", async () => {
    await seed("a");
    await patch({ source_id: "a", decision: "accept" });
    await patch({ source_id: "a", reason_code: "A6" });
    expect((await record("a")).review).toMatchObject({ reason_code: "A6", reason: null });
    await patch({ source_id: "a", reason_code: "A6", reason: "Only source for tide tables" });
    expect((await history("a")).at(-1)).toMatchObject({ reason_code: "A6", reason_label: "Other (explain)", reason: "Only source for tide tables" });
  });

  it("clears the Other text when a different reason is chosen", async () => {
    await seed("a");
    await patch({ source_id: "a", decision: "accept" });
    await patch({ source_id: "a", reason_code: "A6", reason: "Explained" });
    await patch({ source_id: "a", reason_code: "A1" });
    expect((await record("a")).review).toMatchObject({ reason_code: "A1", reason: null });
  });

  it("clears the code and Other text when the decision changes or is cleared, but not when it is sent again", async () => {
    await seed("a");
    await patch({ source_id: "a", decision: "accept" });
    await patch({ source_id: "a", reason_code: "A6", reason: "Explained" });
    await patch({ source_id: "a", decision: "accept" });
    expect((await record("a")).review).toMatchObject({ reason_code: "A6", reason: "Explained" });
    await patch({ source_id: "a", decision: "reject" });
    expect((await record("a")).review).toMatchObject({ decision: "reject", reason_code: null, reason: null });
    await patch({ source_id: "a", reason_code: "R2" });
    await patch({ source_id: "a", decision: null });
    expect((await record("a")).review).toMatchObject({ decision: null, reason_code: null, reason: null });
    expect((await history("a")).map((row) => row.reason)).toContain("Explained");
  });

  it("keeps free text from before codes through codes and decision changes", async () => {
    await seed("a");
    await sourceMap(db).updateOne({ _id: `${locationId}:a` }, { $set: { review: { decision: "reject", reason: "Old words", initial_status: "active", by: "labeller@example.test", at: "2026-11-01T00:00:00.000Z" } } });
    await patch({ source_id: "a", reason_code: "R1" });
    expect((await record("a")).review).toMatchObject({ reason_code: "R1", reason: "Old words" });
    await patch({ source_id: "a", decision: "accept" });
    expect((await record("a")).review).toMatchObject({ reason_code: null, reason: "Old words" });
  });

  it("gives password-only viewers the code and text", async () => {
    await seed("a");
    await label("a", { decision: "reject" });
    await label("a", { reason_code: "R9", reason: "Explained" });
    vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
    mocks.cookies.mockResolvedValue({ get: () => ({ value: internalToken(password) }) });
    const [source] = (await (await allMapGet(new Request(`https://${host}/api/maps/source-map`))).json()).sources;
    expect(source.review).toMatchObject({ reason_code: "R9", reason: "Explained" });
  });
});

describe("labels survive the pipeline", () => {
  it("keeps labels, statuses and reasons through later map runs", async () => {
    await seed("no");
    await seed("yes", "proposed");
    await label("no", { decision: "reject" });
    await label("no", { reason: "Spam" });
    await label("yes", { decision: "accept" });
    for (const status of [undefined, "proposed"] as const) {
      await upsertCandidates(db, locationId, [candidate("no", { name: "Renamed", status }), candidate("yes", { name: "Renamed", status })]);
    }
    expect(await record("no")).toMatchObject({ status: "rejected", review: { decision: "reject", reason: "Spam", initial_status: "active" } });
    expect(await record("yes")).toMatchObject({ status: "active", review: { decision: "accept", initial_status: "proposed" } });
  });

  it("refreshes a labelled source's details without changing the label", async () => {
    await seed("fresh");
    await label("fresh", { decision: "reject" });
    await upsertCandidates(db, locationId, [candidate("fresh", { name: "Renamed" })]);
    expect(await record("fresh")).toMatchObject({ name: "Renamed", status: "rejected" });
  });

  it("does not let empty or failing runs put an accepted source to sleep", async () => {
    await seed("quiet", "proposed");
    await seed("broken");
    await label("quiet", { decision: "accept" });
    await label("broken", { decision: "accept" });
    for (let run = 0; run < 5; run += 1) {
      await recordSourceRun(db, locationId, "quiet", { ...emptyRun });
      await recordSourceRun(db, locationId, "broken", { ...failedRun });
    }
    expect(await record("quiet")).toMatchObject({ status: "active", dormant_until: null, health: { empty_runs: 5 } });
    expect(await record("broken")).toMatchObject({ status: "active", health: { consecutive_failures: 5 } });
  });

  it("accepting a dormant source wakes it and keeps it awake", async () => {
    await seed("sleepy");
    for (let run = 0; run < 3; run += 1) await recordSourceRun(db, locationId, "sleepy", { ...emptyRun });
    expect((await record("sleepy")).status).toBe("dormant");
    await label("sleepy", { decision: "accept" });
    expect(await record("sleepy")).toMatchObject({ status: "active", dormant_until: null, review: { initial_status: "dormant" } });
    await recordSourceRun(db, locationId, "sleepy", { ...emptyRun });
    expect((await record("sleepy")).status).toBe("active");
  });

  it("leaves unlabelled and un-accepted sources on the normal dormant path", async () => {
    await seed("plain");
    await seed("reasoned");
    await label("reasoned", { reason: "Unsure" });
    for (let run = 0; run < 3; run += 1) {
      await recordSourceRun(db, locationId, "plain", { ...emptyRun });
      await recordSourceRun(db, locationId, "reasoned", { ...emptyRun });
    }
    expect((await record("plain")).status).toBe("dormant");
    expect((await record("reasoned")).status).toBe("dormant");
  });

  it("does not revive a rejected source when health is recorded", async () => {
    await seed("gone");
    await label("gone", { decision: "reject" });
    await recordSourceRun(db, locationId, "gone", { ...emptyRun, found: 4, local: 4 });
    expect((await record("gone")).status).toBe("rejected");
  });

  it("does not overwrite a label made while a run is saving health", async () => {
    await seed("racing");
    for (let run = 0; run < 2; run += 1) await recordSourceRun(db, locationId, "racing", { ...emptyRun });
    // The run reads the source as active, then a person rejects it before the run writes back.
    const collection = sourceMap(db);
    const read = collection.findOne.bind(collection);
    const spy = vi.spyOn(Object.getPrototypeOf(collection), "findOne").mockImplementationOnce(async function (this: typeof collection, ...args: unknown[]) {
      const found = await (read as (...values: unknown[]) => Promise<unknown>)(...args);
      await setSourceStatus(db, locationId, "racing", "rejected");
      return found;
    });
    await recordSourceRun(db, locationId, "racing", { ...emptyRun });
    spy.mockRestore();
    expect((await record("racing")).status).toBe("rejected");
  });

  it("won't re-add a source a person rejected until its decision changes", async () => {
    const url = "https://labelled.example.test/news";
    const link = { type: "web", name: "Labelled", url, section: "news" };
    const sourceId = webSourceId(url);
    await upsertCandidates(db, locationId, [candidate(sourceId, { url })]);
    await label(sourceId, { decision: "reject" });
    await expect(addSourceLink(db, loadSettings(), locationId, link)).rejects.toThrow(InvalidSourceLink);
    expect((await record(sourceId)).status).toBe("rejected");
    await label(sourceId, { decision: null });
    await addSourceLink(db, loadSettings(), locationId, link);
    expect((await record(sourceId)).status).toBe("pinned");
  });

  it("files an older athletics link under sports", async () => {
    const url = "https://labelled.example.test/athletics";
    await addSourceLink(db, loadSettings(), locationId, { connector: "athletics", name: "Athletics", url });
    expect((await record(webSourceId(url))).section).toBe("sports");
  });

  it("keeps the history when source records are deleted", async () => {
    await seed("kept");
    await label("kept", { decision: "reject" });
    await removeLocationSources(db, locationId);
    expect(await sourceMap(db).countDocuments({ location_id: locationId })).toBe(0);
    expect(await history("kept")).toHaveLength(1);
    await seed("kept2");
    await label("kept2", { reason: "Still here" });
    await removeLocationRecords(db, locationId, []);
    expect(await sourceMap(db).countDocuments({ location_id: locationId })).toBe(0);
    expect(await history("kept2")).toHaveLength(1);
  });
});

describe("the labelling API", () => {
  it("takes the reviewer from the session, never the browser", async () => {
    await seed("a");
    const response = await patch({ source_id: "a", decision: "accept", by: "someone-else@example.test", review: { by: "someone-else@example.test" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "active", review: { decision: "accept", by: "labeller@example.test" } });
    expect((await record("a")).review?.by).toBe("labeller@example.test");
  });

  it("needs a signed-in journalist and a same-origin request", async () => {
    await seed("a");
    mocks.auth.mockResolvedValue(null);
    expect((await patch({ source_id: "a", decision: "reject" })).status).toBe(401);
    mocks.auth.mockResolvedValue({ user: { email: "labeller@example.test" } });
    expect((await patch({ source_id: "a", decision: "reject" }, { origin: "https://elsewhere.example.test" })).status).toBe(403);
    expect((await record("a")).status).toBe("active");
    expect(await history("a")).toEqual([]);
  });

  it("validates decisions and reasons", async () => {
    await seed("a");
    const bad = [{ decision: "maybe" }, { decision: 1 }, { reason: 7 }, { reason_code: "A6", reason: "x".repeat(MAX_REVIEW_REASON + 1) }, { decision: "accept", status: "paused" }];
    for (const body of bad) expect((await patch({ source_id: "a", ...body })).status).toBe(400);
    expect((await record("a")).review).toBeUndefined();
    expect((await patch({ source_id: "missing", decision: "accept" })).status).toBe(404);
    expect((await patch({ source_id: "a", decision: "accept" })).status).toBe(200);
    expect((await patch({ source_id: "a", reason_code: "A6", reason: "x".repeat(MAX_REVIEW_REASON) })).status).toBe(200);
  });

  it("treats a blank reason as no reason", async () => {
    await seed("a");
    await patch({ source_id: "a", decision: "accept" });
    await patch({ source_id: "a", reason_code: "A6", reason: "Local" });
    await patch({ source_id: "a", reason_code: "A6", reason: "   " });
    expect((await record("a")).review).toMatchObject({ reason_code: "A6", reason: null });
  });

  it("returns a long reason with links exactly as it was saved", async () => {
    await seed("a");
    const reason = `${"Long reasoning. ".repeat(60)}See https://example.test/page?id=7#top`;
    await patch({ source_id: "a", decision: "accept" });
    await patch({ source_id: "a", reason_code: "A6", reason });
    const body = await (await GET(new Request(`https://${host}/api/admin/locations/${locationId}/source-map`), context)).json();
    expect(body.sources[0].review.reason).toBe(reason.trim());
  });

  it("still redacts the rest of a source", async () => {
    await upsertCandidates(db, locationId, [candidate("a")]);
    await sourceMap(db).updateOne({ _id: `${locationId}:a` }, { $set: { health: { ...emptyHealth(), last_detail: "failed https://example.test/feed?token=hidden" } } });
    const body = await (await GET(new Request(`https://${host}/api/admin/locations/${locationId}/source-map`), context)).json();
    expect(JSON.stringify(body)).not.toContain("hidden");
  });

  it("keeps rejected sources in every listing, without reviewer emails for password-only viewers", async () => {
    await seed("a");
    await label("a", { decision: "reject" });
    await label("a", { reason: "Spam" });
    vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
    mocks.cookies.mockResolvedValue({ get: () => ({ value: internalToken(password) }) });
    const url = `https://${host}/api/maps/source-map`;
    for (const response of [await mapGet(new Request(url), context), await allMapGet(new Request(url))]) {
      const [source] = (await response.json()).sources;
      expect(source).toMatchObject({ status: "rejected", review: { decision: "reject", reason: "Spam", initial_status: "active" } });
      expect(source.review.by).toBeUndefined();
    }
    const admin = await (await GET(new Request(`https://${host}/api/admin/locations/${locationId}/source-map`), context)).json();
    expect(admin.sources[0].status).toBe("rejected");
  });

  it("keeps one path for rejecting, and action buttons working otherwise", async () => {
    await seed("a");
    expect((await patch({ source_id: "a", status: "rejected" })).status).toBe(400);
    expect((await patch({ source_id: "a", status: "paused" })).status).toBe(200);
    expect((await patch({ source_id: "a", status: "pinned" })).status).toBe(200);
    expect((await patch({ source_id: "a", status: "active" })).status).toBe(200);
    await label("a", { decision: "reject" });
    expect((await patch({ source_id: "a", status: "active" })).status).toBe(400);
    expect((await record("a")).status).toBe("rejected");
    expect((await patch({ source_id: "a", decision: null })).status).toBe(200);
    expect((await patch({ source_id: "a", status: "pinned" })).status).toBe(200);
  });
});

describe("non-scrapable sources", () => {
  const linkOnly = (sourceId: string, overrides: Partial<SourceCandidate> = {}) => candidate(sourceId, { link_only: true, status: "proposed", why: "On a platform we don't read: an editor can check it", ...overrides });
  const sources = [
    { status: "active" }, { status: "active", link_only: true }, { status: "proposed" }, { status: "proposed", link_only: true }, { status: "pinned", link_only: true },
    { status: "rejected", link_only: true }, { status: "paused", link_only: true }, { status: "dormant", link_only: true },
  ];
  const filtered = (status: string) => sources.filter((source) => liveStatus(source) === status);

  it("shows link-only sources as non-scrapable, except rejected, paused and dormant", () => {
    expect(sources.map(liveStatus)).toEqual(["active", NON_SCRAPABLE, "proposed", NON_SCRAPABLE, NON_SCRAPABLE, "rejected", "paused", "dormant"]);
    expect(displayStatus("proposed", false)).toBe("proposed");
  });

  it("filters Active and Proposed without non-scrapable sources", () => {
    expect(filtered("active")).toEqual([{ status: "active" }]);
    expect(filtered("proposed")).toEqual([{ status: "proposed" }]);
    expect(filtered("pinned")).toEqual([]);
    expect(filtered(NON_SCRAPABLE)).toHaveLength(3);
    expect(filtered("rejected")).toEqual([{ status: "rejected", link_only: true }]);
  });

  it("counts each source once", () => {
    const counts = statusCounts(sources);
    expect(counts).toEqual({ active: 1, proposed: 1, [NON_SCRAPABLE]: 3, rejected: 1, paused: 1, dormant: 1 });
    expect(Object.values(counts).reduce((total, count) => total + count, 0)).toBe(sources.length);
  });

  it("derives the reason from what discovery stored", () => {
    const access = { robots: "blocked", rights: "unknown", fresh: false } as const;
    const rows: Array<[Parameters<typeof nonScrapableReason>[0], string | null]> = [
      [{ link_only: false, why: "Blocked from reading" }, null],
      [{ link_only: true, access: { robots: "allowed", rights: "link-only", fresh: true }, why: "Names Fixture Town" }, "Rights: headline and link only"],
      [{ link_only: true, access, source_kind: "lookup", why: "On a platform we don't read: an editor can check it" }, "Blocked platform"],
      [{ link_only: true, access, why: "Useful page (On a platform we don't read: an editor can check it)" }, "Blocked platform"],
      [{ link_only: true, access, why: "Blocked from reading, kept as a link-only lead" }, "Blocked from reading"],
      [{ link_only: true, access: { robots: "allowed", rights: "ok", fresh: false }, source_kind: "lookup", why: "A lookup or dashboard: kept as a link for checking facts" }, "Lookup tool"],
      [{ link_only: true, access: { robots: "allowed", rights: "ok", fresh: false }, why: "No current dated items found, possibly built by script: kept as a link for an editor" }, "No current dates found"],
      [{ link_only: true, found_by: { detail: "CivicPlus Agenda Center (agendas are PDFs: listed with a link)" } }, "Agendas are PDFs"],
      [{ link_only: true, found_by: { detail: "PrimeGov portal found by name; agendas are PDFs (listed with a link)" } }, "Agendas are PDFs"],
      [{ link_only: true }, UNKNOWN_REASON],
    ];
    for (const [source, reason] of rows) expect(nonScrapableReason(source)).toBe(reason);
  });

  it("accepting records the decision, stays link-only and is still not collected", async () => {
    await upsertCandidates(db, locationId, [linkOnly("link")]);
    await label("link", { decision: "accept" });
    const source = await record("link");
    expect(source).toMatchObject({ status: "active", link_only: true, review: { decision: "accept", initial_status: "proposed" } });
    expect(liveStatus(source)).toBe(NON_SCRAPABLE);
    expect(await collectableSources(db, locationId, today)).toEqual([]);
    expect(await collectableSources(db, locationId, today, "agentic")).toEqual([]);
  });

  it("keeps link_only and the reason in the history", async () => {
    await upsertCandidates(db, locationId, [linkOnly("link"), candidate("plain")]);
    await label("link", { decision: "reject" });
    await label("plain", { decision: "reject" });
    expect((await history("link"))[0]).toMatchObject({ link_only: true, non_scrapable_reason: "Blocked platform" });
    expect((await history("plain"))[0]).toMatchObject({ link_only: false, non_scrapable_reason: null });
  });

  it("reaches both tables with the fields the reason needs", async () => {
    await upsertCandidates(db, locationId, [linkOnly("link")]);
    vi.stubEnv("NEWSBEE_INTERNAL_PASSWORD", password);
    mocks.cookies.mockResolvedValue({ get: () => ({ value: internalToken(password) }) });
    const url = `https://${host}/api/maps/source-map`;
    for (const response of [await GET(new Request(url), context), await mapGet(new Request(url), context), await allMapGet(new Request(url))]) {
      expect(nonScrapableReason((await response.json()).sources[0])).toBe("Blocked platform");
    }
  });

  describe("what a later run can change", () => {
    const readable = (sourceId: string, status?: SourceStatus) => candidate(sourceId, { link_only: false, status, why: "Names Fixture Town" });

    it("a proposed source becomes readable when a later agentic run reads it", async () => {
      await upsertCandidates(db, locationId, [linkOnly("a")]);
      await upsertCandidates(db, locationId, [readable("a", "proposed")]);
      expect(await record("a")).toMatchObject({ status: "proposed", link_only: false });
    });

    it("an accepted source is frozen against agentic runs, so the newer result isn't kept on the map", async () => {
      await upsertCandidates(db, locationId, [linkOnly("a")]);
      await label("a", { decision: "accept" });
      await upsertCandidates(db, locationId, [readable("a", "proposed")]);
      expect(await record("a")).toMatchObject({ status: "active", link_only: true });
    });

    it("a rejected source is frozen the same way", async () => {
      await upsertCandidates(db, locationId, [linkOnly("a")]);
      await label("a", { decision: "reject" });
      await upsertCandidates(db, locationId, [readable("a", "proposed")]);
      expect(await record("a")).toMatchObject({ status: "rejected", link_only: true });
    });

    it("a candidate that isn't proposed does change it, whatever the label", async () => {
      await upsertCandidates(db, locationId, [linkOnly("a")]);
      await label("a", { decision: "accept" });
      await upsertCandidates(db, locationId, [readable("a")]);
      expect(await record("a")).toMatchObject({ status: "active", link_only: false, review: { decision: "accept" } });
    });
  });
});
