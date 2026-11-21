import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { GET as inboxGet } from "../../../app/api/admin/inbox/route";
import { GET as storiesGet, POST as storiesPost } from "../../../app/api/admin/reader-stories/route";
import { POST as noticesPost } from "../../../app/api/admin/remembrance/route";
import { POST as reportsPost } from "../../../app/api/admin/reports/route";
import { POST as suggestionsPost } from "../../../app/api/admin/suggestions/route";
import { GET as sourceMapGet, PATCH as sourceMapPatch } from "../../../app/api/admin/locations/[locationId]/source-map/route";
import { POST as reviewsPost } from "../../../app/api/admin/locations/[locationId]/source-map/reviews/route";
import { POST as mapRunPost } from "../../../app/api/admin/locations/[locationId]/map-run/route";
import { GET as sourceRunsGet } from "../../../app/api/maps/locations/[locationId]/source-runs/route";
import { GET as sourceRunGet } from "../../../app/api/maps/locations/[locationId]/source-runs/[runId]/route";
import { POST as runDecisionsPost } from "../../../app/api/admin/locations/[locationId]/source-runs/[runId]/decisions/route";
import { POST as linksPost } from "../../../app/api/admin/locations/[locationId]/links/route";
import { COLLECTIONS } from "../../storage/mongo";
import { sourceMap, upsertCandidates } from "../../sourcemap/store";
import { readerStories } from "../../connectors/neighbours";
import { remembranceSubmissions } from "../../connectors/remembrance";
import { sourceSuggestions } from "../../connectors/manual-links";
import { storyReports } from "../../orchestration/inbox";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), headers: vi.fn(), cookies: vi.fn(), deps: vi.fn(), database: vi.fn(), startMapRun: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth, isAdminEmail: vi.fn(), getMongoDatabase: mocks.database }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: mocks.deps }));
vi.mock("@/pipeline/storage/mongo", async (original) => ({ ...await original<object>(), getDatabase: mocks.database }));
vi.mock("@/lib/pipeline-queue", () => ({ queueNextJob: vi.fn() }));
vi.mock("@/lib/job-chain", () => ({ callNextJob: vi.fn() }));
vi.mock("@/pipeline/orchestration/orchestrator", async (original) => ({ ...await original<object>(), startMapRun: mocks.startMapRun }));

const host = "workspace.example.test";
const people = {
  editor: { email: "editor@example.test", principalId: "editor", role: "editor" },
  outsider: { email: "outsider@example.test", principalId: "outsider", role: "editor" },
  admin: { email: "admin@example.test", principalId: "admin", role: "admin" },
};
type Person = keyof typeof people;

let server: MongoMemoryServer, client: MongoClient, db: Db;
const signIn = (person: Person) => mocks.auth.mockResolvedValue({ user: { email: people[person].email, newsbeePrincipalId: people[person].principalId } });
const url = (path: string, publication?: string) => `https://${host}/api/${path}${publication ? `${path.includes("?") ? "&" : "?"}publication=${publication}` : ""}`;
const get = (path: string, publication?: string) => new Request(url(path, publication));
const send = (path: string, body: unknown, publication?: string, method = "POST") => new Request(url(path, publication), {
  method, headers: { origin: `https://${host}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
const at = (locationId: string) => ({ params: Promise.resolve({ locationId }) });

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("newsroom_scope_routes");
}, 60_000);
beforeEach(async () => {
  await db.dropDatabase();
  mocks.headers.mockResolvedValue(new Headers({ host }));
  mocks.cookies.mockResolvedValue({ get: () => undefined });
  mocks.database.mockResolvedValue(db);
  mocks.deps.mockResolvedValue({ db, settings: {} });
  mocks.startMapRun.mockResolvedValue({ run: { _id: "map-run" }, started: true });
  await db.collection("journalist_admins").insertMany(Object.values(people).map((person) => ({ ...person, enabled: true })));
  await db.collection(COLLECTIONS.outputChannels).insertMany([
    { _id: "north-room", owner_id: "admin", name: "North newsroom", enabled: true, selected_location_ids: ["north"], allowed_location_ids: ["north"],
      members: [{ principal_id: "editor", role: "editor" }] },
    { _id: "south-room", owner_id: "admin", name: "South newsroom", enabled: true, selected_location_ids: ["south"], allowed_location_ids: ["south"],
      members: [{ principal_id: "outsider", role: "editor" }] },
  ] as never[]);
  await db.collection(COLLECTIONS.locations).insertMany(["north", "south"].map((id) => ({ _id: id, id, name: `${id} town`, state: "WA", systems: [] })) as never[]);
  const submitted = new Date().toISOString();
  await readerStories(db).insertMany(["north", "south"].map((location) => ({ _id: `story-${location}`, location_id: location, location_name: location,
    headline: `${location} story`, story: "Body", topic: "news", status: "pending", submitted_at: submitted })) as never[]);
  await remembranceSubmissions(db).insertMany(["north", "south"].map((location) => ({ _id: `notice-${location}`, location_id: location, location_name: location,
    status: "pending", submitted_at: submitted })) as never[]);
  await sourceSuggestions(db).insertMany(["north", "south"].map((location) => ({ _id: `suggestion-${location}`, location_id: location, location_name: location,
    name: `${location} paper`, url: `https://${location}.example.test`, section: "news", status: "pending", submitted_at: submitted })) as never[]);
  await storyReports(db).insertMany(["north", "south"].map((location) => ({ _id: `report-${location}`, location_id: location, edition_id: null, story_id: null,
    headline: null, message: "Typo", status: "open", submitted_at: submitted })) as never[]);
  for (const location of ["north", "south"]) {
    await upsertCandidates(db, location, [{ source_id: `${location}-source`, name: `${location} source`, url: `https://${location}.example.test/news`, reader: "web",
      params: {}, section: "news", inside_area: true, found_by: { method: "agent", detail: "Fixture" }, status: "proposed" } as never]);
  }
});
afterEach(() => { vi.resetAllMocks(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

describe("journalist inbox", () => {
  it("shows a journalist only their own newsroom's communities and refuses other newsrooms", async () => {
    signIn("editor");
    const response = await inboxGet(get("admin/inbox", "north-room"));
    expect(response.status).toBe(200);
    const inbox = await response.json();
    expect(inbox.reader_stories.map((item: { _id: string }) => item._id)).toEqual(["story-north"]);
    expect(inbox.family_notices.map((item: { _id: string }) => item._id)).toEqual(["notice-north"]);
    expect(inbox.suggestions.map((item: { _id: string }) => item._id)).toEqual(["suggestion-north"]);
    expect(inbox.reports.map((item: { _id: string }) => item._id)).toEqual(["report-north"]);
    expect((await inboxGet(get("admin/inbox"))).status).toBe(403);
    expect((await inboxGet(get("admin/inbox", "south-room"))).status).toBe(404);
    expect((await inboxGet(get("admin/inbox?location=south", "north-room"))).status).toBe(404);
    expect((await storiesGet(get("admin/reader-stories?location=south", "north-room"))).status).toBe(404);
  });

  it("lets a journalist act on their newsroom's queue items, recording who decided, but not on another newsroom's", async () => {
    signIn("editor");
    const approve = await storiesPost(send("admin/reader-stories", { id: "story-north", decision: "approved" }, "north-room"));
    expect(approve.status).toBe(200);
    expect(await readerStories(db).findOne({ _id: "story-north" })).toMatchObject({ status: "approved", decided_by: people.editor.email });
    expect((await storiesPost(send("admin/reader-stories", { id: "story-south", decision: "approved" }, "north-room"))).status).toBe(404);
    expect(await readerStories(db).findOne({ _id: "story-south" })).toMatchObject({ status: "pending" });
    expect((await noticesPost(send("admin/remembrance", { id: "notice-north", decision: "rejected" }, "north-room"))).status).toBe(200);
    expect((await noticesPost(send("admin/remembrance", { id: "notice-south", decision: "rejected" }, "north-room"))).status).toBe(404);
    expect((await reportsPost(send("admin/reports", { id: "report-north" }, "north-room"))).status).toBe(200);
    expect(await storyReports(db).findOne({ _id: "report-north" })).toMatchObject({ status: "resolved", resolved_by: people.editor.email });
    expect((await reportsPost(send("admin/reports", { id: "report-south" }, "north-room"))).status).toBe(404);
    expect((await suggestionsPost(send("admin/suggestions", { id: "suggestion-north", decision: "rejected" }, "north-room"))).status).toBe(200);
    expect((await suggestionsPost(send("admin/suggestions", { id: "suggestion-south", decision: "rejected" }, "north-room"))).status).toBe(404);
    expect(await sourceSuggestions(db).findOne({ _id: "suggestion-south" })).toMatchObject({ status: "pending" });
    // Acting from another newsroom's page is refused outright.
    expect((await reportsPost(send("admin/reports", { id: "report-south" }, "south-room"))).status).toBe(404);
  });

  it("leaves operators unchanged: every community without a newsroom, narrowed when they open one", async () => {
    signIn("admin");
    const all = await (await inboxGet(get("admin/inbox"))).json();
    expect(all.reader_stories.map((item: { _id: string }) => item._id).sort()).toEqual(["story-north", "story-south"]);
    const narrowed = await (await inboxGet(get("admin/inbox", "north-room"))).json();
    expect(narrowed.reader_stories.map((item: { _id: string }) => item._id)).toEqual(["story-north"]);
    expect((await reportsPost(send("admin/reports", { id: "report-south" }))).status).toBe(200);
  });
});

describe("journalist source map", () => {
  it("lets a journalist view and decide their newsroom's sources, recorded with their email", async () => {
    signIn("editor");
    expect((await sourceMapGet(get("admin/locations/north/source-map", "north-room"), at("north"))).status).toBe(200);
    expect((await sourceMapGet(get("admin/locations/south/source-map", "north-room"), at("south"))).status).toBe(404);
    expect((await sourceMapGet(get("admin/locations/north/source-map"), at("north"))).status).toBe(403);
    const accept = await sourceMapPatch(send("admin/locations/north/source-map", { source_id: "north-source", decision: "accept", reason_code: "A2" }, "north-room", "PATCH"), at("north"));
    expect(accept.status).toBe(200);
    expect(await sourceMap(db).findOne({ _id: "north:north-source" })).toMatchObject({ status: "active", review: { decision: "accept", by: people.editor.email } });
    const bulk = await reviewsPost(send("admin/locations/south/source-map/reviews", { source_ids: ["south-source"], decision: "reject", reason_code: "R1" }, "north-room"), at("south"));
    expect(bulk.status).toBe(404);
    expect(await sourceMap(db).findOne({ _id: "south:south-source" })).toMatchObject({ status: "proposed" });
    // Pausing, pinning and windows stay with operators.
    expect((await sourceMapPatch(send("admin/locations/north/source-map", { source_id: "north-source", status: "paused" }, "north-room", "PATCH"), at("north"))).status).toBe(403);
    expect((await sourceRunsGet(get("maps/locations/north/source-runs", "north-room"), at("north"))).status).toBe(200);
    expect((await sourceRunsGet(get("maps/locations/south/source-runs", "north-room"), at("south"))).status).toBe(404);
  });

  it("lets a journalist start a source run only for a community their newsroom covers, from that newsroom", async () => {
    signIn("editor");
    const started = await mapRunPost(send("admin/locations/north/map-run", { rebuild: false }, "north-room"), at("north"));
    expect(started.status).toBe(200);
    expect(mocks.startMapRun).toHaveBeenCalledWith(expect.anything(), "north", { by: people.editor.email, kind: "manual" }, undefined, false, "north-room");
    expect((await mapRunPost(send("admin/locations/south/map-run", {}, "north-room"), at("south"))).status).toBe(404);
    expect((await mapRunPost(send("admin/locations/south/map-run", {}, "south-room"), at("south"))).status).toBe(404);
    expect((await mapRunPost(send("admin/locations/north/map-run", {}), at("north"))).status).toBe(403);
    expect(mocks.startMapRun).toHaveBeenCalledTimes(1);
    signIn("admin");
    expect((await mapRunPost(send("admin/locations/south/map-run", {}), at("south"))).status).toBe(200);
    expect(mocks.startMapRun).toHaveBeenLastCalledWith(expect.anything(), "south", { by: people.admin.email, kind: "manual" }, undefined, false, undefined);
  });

  it("keeps adding a source, run details and run decisions to the journalist's own newsroom", async () => {
    await db.collection(COLLECTIONS.runs).insertMany(["north", "south"].map((location) => ({
      _id: `${location}-run`, location_id: location, kind: "map", isolated: false, status: "done", created_at: 1,
    })) as never[]);
    const run = (location: string) => ({ params: Promise.resolve({ locationId: location, runId: `${location}-run` }) });
    const source = { type: "web", name: "South paper", url: "https://south.example.test/news", section: "news" };
    signIn("editor");
    // Another newsroom's community, from the editor's own newsroom or by naming the other newsroom: not found.
    expect((await linksPost(send("admin/locations/south/links", source, "north-room"), at("south"))).status).toBe(404);
    expect((await linksPost(send("admin/locations/south/links", source, "south-room"), at("south"))).status).toBe(404);
    // No newsroom named: refused.
    expect((await linksPost(send("admin/locations/north/links", source), at("north"))).status).toBe(403);
    expect((await sourceRunGet(get("maps/locations/south/source-runs/south-run", "north-room"), run("south"))).status).toBe(404);
    const decision = { source_ids: ["south-source"], decision: "reject", reason_code: "R1" };
    expect((await runDecisionsPost(send("admin/locations/south/source-runs/south-run/decisions", decision, "north-room"), run("south"))).status).toBe(404);
    expect((await runDecisionsPost(send("admin/locations/north/source-runs/north-run/decisions", decision), run("north"))).status).toBe(403);
    // In scope, the route goes on to its own checks: this run wrote to the source map, so its decisions belong in All sources.
    const own = await runDecisionsPost(send("admin/locations/north/source-runs/north-run/decisions", { ...decision, source_ids: ["north-source"] }, "north-room"), run("north"));
    expect(own.status).toBe(400);
    expect((await own.json()).detail).toContain("decide its sources in All sources");
    expect(await sourceMap(db).findOne({ _id: "south:south-source" })).toMatchObject({ status: "proposed" });
  });
});
