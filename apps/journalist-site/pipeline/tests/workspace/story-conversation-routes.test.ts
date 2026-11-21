import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { enterMaintenance, fencedDatabase, maintenanceState, reopenMaintenance } from "../../../../../shared/restore-maintenance";
import { publicationContentHash, type PublicationManifestV1, type PublicationReleasePayloadV1 } from "../../../../../shared/publication-release";
import { mongoChannelFolderId } from "../../../../../shared/reader-folder";
const deps = vi.hoisted(() => ({ readerData: vi.fn(), readerDatabase: vi.fn(), publication: vi.fn(), read: vi.fn(), comment: vi.fn(), feedback: vi.fn() }));
vi.mock("../../../../reader-site/src/lib/reader-data", () => ({ readerData: deps.readerData, readerDatabase: deps.readerDatabase, loadReaderPublication: deps.publication }));
vi.mock("../../../../reader-site/src/lib/story-conversation", async (original) => ({ ...await original<typeof import("../../../../reader-site/src/lib/story-conversation")>(), readStoryConversation: deps.read, saveStoryComment: deps.comment, saveStoryFeedback: deps.feedback }));
import { GET, POST } from "../../../../reader-site/src/pages/api/story-conversation";
import { StoryConversationError } from "../../../../reader-site/src/lib/story-conversation";
const url = new URL("https://newsbee.test/reader/api/story-conversation");
const story = { location_id: "town-wa", edition_id: "edition-1", story_id: "story-1" };
const publicationStory = { publication_id: "local-paper", release_id: "release-1", story_id: "story-1" };
const request = (body: unknown, headers: Record<string, string> = {}) => ({ request: new Request(url, { method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), url, clientAddress: "127.0.0.1" }) as Parameters<typeof POST>[0];
let server: MongoMemoryServer, client: MongoClient, db: Db, readerDb: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("story-conversation-routes"); });
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  vi.resetAllMocks();
  await db.dropDatabase();
  readerDb = await fencedDatabase(db);
  deps.readerData.mockResolvedValue({ editions: [{ id: "edition-1", location_id: "town-wa", items: [{ story_id: "story-1" }, { headline: "A legacy story" }] }] });
  deps.readerDatabase.mockResolvedValue(readerDb); deps.read.mockResolvedValue({ comments: [], total: 0, feedback: null });
  deps.publication.mockResolvedValue({ entry: { withdrawn: false }, release: { items: [{ item_id: "story-1" }] } });
});
it("rejects cross-origin, non-JSON and oversized requests before touching storage", async () => {
  expect((await POST(request({ ...story, action: "comment", message: "A thoughtful comment" }, { Origin: "https://elsewhere.test" }))).status).toBe(403);
  expect((await POST(request({}, { "Content-Type": "text/plain" }))).status).toBe(415);
  expect((await POST(request({ message: "x".repeat(13_000) }))).status).toBe(413);
  expect(deps.readerDatabase).not.toHaveBeenCalled();
});
it("rejects malformed payloads and unknown edition/story combinations", async () => {
  for (const body of [null, [], { ...story, action: "feedback", useful: "true" }, { ...story, action: "comment", message: "a" }, { ...story, action: "comment", message: "good", name: "x".repeat(81) }]) {
    expect((await POST(request(body))).status).toBeGreaterThanOrEqual(400);
  }
  for (const invalid of [{ ...story, location_id: "other-town" }, { ...story, edition_id: "other-edition" }, { ...story, story_id: "other-story" }]) {
    expect((await POST(request({ ...invalid, action: "comment", message: "A thoughtful comment" }))).status).toBe(404);
  }
  expect(deps.comment).not.toHaveBeenCalled();
});
it("accepts comments with a stable private visitor cookie and only validated fields", async () => {
  const visitor = "23359b06-77d3-4b68-a879-670a8556eac3";
  const response = await POST(request({ ...story, action: "comment", message: "  This is useful.  ", name: " Alex ", status: "approved" }, { Cookie: `newsbee_conversation=${visitor}` }));
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(deps.comment).toHaveBeenCalledWith(readerDb, story, { message: "This is useful.", name: "Alex" }, visitor, "127.0.0.1");
  expect(deps.readerData).toHaveBeenCalledWith(undefined, { locationId: story.location_id, editionId: story.edition_id });
  expect(await response.json()).toEqual({ comments: [], total: 0, feedback: null });
});
it("reads only a published story and supports legacy edition item identifiers", async () => {
  const getUrl = new URL(`${url}?${new URLSearchParams({ ...story, story_id: "item:2" })}`);
  const response = await GET({ request: new Request(getUrl), url: getUrl } as Parameters<typeof GET>[0]);
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax; Secure");
  expect(deps.read.mock.calls[0][1]).toEqual({ ...story, story_id: "item:2" });
});
it("uses the renderer's canonical item identifier for legacy edition conversations", async () => {
  deps.readerData.mockResolvedValue({ editions: [{ id: story.edition_id, location_id: story.location_id,
    items: [{ item_id: "canonical-item", story_id: "older-story-id" }] }] });
  const canonical = new URL(`${url}?${new URLSearchParams({ ...story, story_id: "canonical-item" })}`);
  expect((await GET({ request: new Request(canonical), url: canonical } as Parameters<typeof GET>[0])).status).toBe(200);
  expect(deps.read.mock.calls[0][1]).toEqual({ ...story, story_id: "canonical-item" });
  const obsolete = new URL(`${url}?${new URLSearchParams({ ...story, story_id: "older-story-id" })}`);
  expect((await GET({ request: new Request(obsolete), url: obsolete } as Parameters<typeof GET>[0])).status).toBe(404);
});
it("persists helpfulness separately and returns retryable failures without exposing storage errors", async () => {
  expect((await POST(request({ ...story, action: "feedback", useful: false }))).status).toBe(200);
  expect(deps.feedback.mock.calls[0].slice(0, 3)).toEqual([readerDb, story, false]);
  deps.comment.mockRejectedValueOnce(new StoryConversationError("Please try later.", 429));
  const limited = await POST(request({ ...story, action: "comment", message: "A thoughtful comment" }));
  expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBe("3600");
  deps.comment.mockRejectedValueOnce(new Error("Private database credentials"));
  const failed = await POST(request({ ...story, action: "comment", message: "A thoughtful comment" }));
  expect(failed.status).toBe(503); expect(JSON.stringify(await failed.json())).not.toContain("credentials");
});
it("uses only the exact canonical public release for publication comments and helpfulness", async () => {
  expect((await POST(request({ ...publicationStory, action: "comment", message: "A thoughtful comment" }))).status).toBe(201);
  expect(deps.publication).toHaveBeenCalledWith(publicationStory.publication_id, publicationStory.release_id, readerDb);
  expect(deps.comment.mock.calls[0][1]).toEqual(publicationStory);
  expect((await POST(request({ ...publicationStory, action: "feedback", useful: true }))).status).toBe(200);
  expect(deps.feedback.mock.calls[0][1]).toEqual(publicationStory);
  expect(deps.readerData).not.toHaveBeenCalled();
});
it("rejects mixed, incomplete and private-preview targets before loading publication content", async () => {
  for (const target of [
    { ...publicationStory, ...story }, { ...publicationStory, location_id: "town-wa" },
    { publication_id: "local-paper", story_id: "story-1" },
    { publication_id: "local-paper", draft_id: "private-draft", revision: 3, story_id: "story-1" },
    { ...publicationStory, draft_id: "private-draft" }, { ...publicationStory, revision: 3 },
  ]) expect((await POST(request({ ...target, action: "comment", message: "A thoughtful comment" }))).status).toBe(422);
  expect(deps.publication).not.toHaveBeenCalled();
  expect(deps.comment).not.toHaveBeenCalled();
  expect(deps.readerDatabase).not.toHaveBeenCalled();
});
it("fails closed for unpublished, unavailable, withdrawn, wrong-story and integrity-invalid releases", async () => {
  for (const release of [null, { entry: { withdrawn: true }, release: { items: [{ item_id: "story-1" }] } },
    { entry: { withdrawn: false }, release: { items: [{ item_id: "another-story" }] } }]) {
    deps.publication.mockResolvedValueOnce(release);
    expect((await POST(request({ ...publicationStory, action: "comment", message: "A thoughtful comment" }))).status).toBe(404);
  }
  deps.publication.mockRejectedValueOnce(new Error("Publication release failed integrity validation"));
  expect((await POST(request({ ...publicationStory, action: "feedback", useful: true }))).status).toBe(503);
  expect(deps.comment).not.toHaveBeenCalled();
  expect(deps.feedback).not.toHaveBeenCalled();
  expect(deps.readerData).not.toHaveBeenCalled();
});
it("holds POST admission through its response and refuses closed or obsolete writers while allowing reads", async () => {
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  let releaseComment!: () => void;
  let commentStarted!: () => void;
  const started = new Promise<void>((resolve) => { commentStarted = resolve; });
  const paused = new Promise<void>((resolve) => { releaseComment = resolve; });
  let inFlight: ReturnType<typeof POST> | undefined;
  try {
    const owner = { id: "owner-id", email: "owner@example.test", role: "owner" };
    await db.collection("journalist_admins").insertOne({ principalId: owner.id, email: owner.email, enabled: true });
    deps.comment.mockImplementationOnce(async () => { commentStarted(); await paused; });
    inFlight = POST(request({ ...story, action: "comment", message: "A thoughtful comment" }));
    await started;
    await enterMaintenance(db, owner);
    expect((await maintenanceState(db)).writers).toHaveLength(1);
    expect((await POST(request({ ...story, action: "feedback", useful: true }))).status).toBe(503);
    expect((await POST(request({ ...publicationStory, action: "comment", message: "A thoughtful comment" }))).status).toBe(503);
    expect(deps.publication).not.toHaveBeenCalled();
    expect(deps.feedback).not.toHaveBeenCalled();
    const getUrl = new URL(`${url}?${new URLSearchParams(story)}`);
    expect((await GET({ request: new Request(getUrl), url: getUrl } as Parameters<typeof GET>[0])).status).toBe(200);
    releaseComment();
    expect((await inFlight).status).toBe(201);
    expect((await maintenanceState(db)).writers).toHaveLength(0);
    await reopenMaintenance(db, owner);
    expect((await POST(request({ ...story, action: "feedback", useful: true }))).status).toBe(503);
    deps.readerDatabase.mockResolvedValue(await fencedDatabase(db));
    expect((await POST(request({ ...story, action: "feedback", useful: true }))).status).toBe(200);
  } finally {
    releaseComment();
    await inFlight;
    vi.unstubAllEnvs();
  }
});
