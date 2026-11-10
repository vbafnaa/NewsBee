import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { saveCredentialProfile } from "../../accounts/credentials";
import { principalForEmail, type Principal } from "../../accounts/identity";
import { infrastructureSettings } from "../../accounts/execution";
import { NO_MODEL } from "../../accounts/runtime";
import { ExecutionBlocked } from "../../core/execution-errors";
import type { OrchestratorDeps } from "../../orchestration/orchestrator";
import { COLLECTIONS } from "../../storage/mongo";
import type { ArtifactStore } from "../../storage/artifacts";

const state = vi.hoisted(() => ({ deps: null as OrchestratorDeps | null, discover: vi.fn(), savePackage: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock("@/lib/admin-api", () => ({
  adminRoute: async (_request: Request, handler: (deps: OrchestratorDeps) => Promise<unknown>) => {
    try { return Response.json(await handler(state.deps!)); }
    catch (error) { return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: error instanceof ExecutionBlocked ? 403 : 500 }); }
  },
  jsonBody: (request: Request) => request.json(),
}));
vi.mock("@/lib/admin-session", () => ({
  adminGuard: async () => null,
  ownerGuard: async () => state.deps?.principal?.role === "owner" ? null : Response.json({ detail: "Owner access required" }, { status: 403 }),
}));
vi.mock("../../discovery/run", () => ({ runMethod: state.discover, locationDiscovery: vi.fn() }));
vi.mock("../../video-production", () => ({
  getVideoStory: async () => ({ storyId: "story", locationId: "one" }),
  videoStoryManagement: async () => ({ videos: [] }),
  saveVideoPackage: state.savePackage,
  newVideoJob: () => ({ _id: "video", story_id: "story", location_id: "one", prompt: "fixture prompt", status: "queued" }),
  generateVideoPackage: vi.fn(),
}));
vi.mock("../../connectors/youtube", () => ({ youtubeConnection: async () => ({ connected: false }) }));
vi.mock("../../youtube-location-settings", () => ({ getYouTubeLocationSettings: async () => null }));
import { POST as discover } from "../../../app/api/admin/discovery/route";
import { GET as videoInfo, POST as videoAction } from "../../../app/api/admin/video-production/[locationId]/[storyId]/route";

let server: MongoMemoryServer, client: MongoClient, db: Db, owner: Principal, editor: Principal;
const store: ArtifactStore = {
  kind: "local", ensureFolder: async () => "fixture", saveText: async () => "fixture", saveJson: async () => "fixture",
  readText: async () => "", readJson: async <T>() => ({} as T), list: async () => [], findFolder: async () => null, removeFile: async () => 0,
};
const context = { params: Promise.resolve({ locationId: "one", storyId: "story" }) };
const request = (body: unknown) => new Request("https://fixture.example.test/api/admin/action", { method: "POST", body: JSON.stringify(body) });
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("personal-actions"); });
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", "owner@example.test");
  vi.stubEnv("NEWSBEE_MODEL_PROVIDERS", "gemini");
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "environment-model");
  vi.stubEnv("NEWSBEE_ATTOM_API_KEY", "environment-attom");
  vi.stubEnv("FAL_KEY", "environment-fal");
  vi.stubEnv("NEWSBEE_CREDENTIAL_KEYS", JSON.stringify({ fixture: Buffer.alloc(32, 7).toString("base64") }));
  vi.stubEnv("NEWSBEE_CREDENTIAL_ACTIVE_KEY", "fixture");
  vi.stubGlobal("fetch", state.fetch);
  await db.dropDatabase();
  owner = (await principalForEmail(db, "owner@example.test"))!;
  await db.collection("journalist_admins").insertOne({ email: "editor@example.test", principalId: "editor", enabled: true });
  editor = (await principalForEmail(db, "editor@example.test"))!;
  state.deps = { db, principal: editor, settings: infrastructureSettings(), model: NO_MODEL, store };
  state.savePackage.mockResolvedValue({ videoPrompt: "fixture prompt" });
  state.discover.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

it("blocks one-off model discovery with no personal profile despite deployment model keys", async () => {
  const response = await discover(request({ location_id: "one", method: "llm" }));
  expect(response.status).toBe(403);
  expect((await response.json()).detail).toContain("personal model API key");
  expect(state.discover).not.toHaveBeenCalled();
  expect(state.fetch).not.toHaveBeenCalled();
});
it("blocks home-sales discovery without the editor's ATTOM key even when deployment has one", async () => {
  const response = await discover(request({ location_id: "one", method: "homesales" }));
  expect(response.status).toBe(403);
  expect((await response.json()).detail).toContain("ATTOM API key");
  expect(state.discover).not.toHaveBeenCalled();
});
it("reports video readiness from personal fal.ai credentials only for non-owners, without requiring a model", async () => {
  expect((await (await videoInfo(request({}), context)).json()).falConfigured).toBe(false);
  await saveCredentialProfile(db, editor, { source: "personal", config: { integrations: { falKey: "personal-fal" } } });
  expect((await (await videoInfo(request({}), context)).json()).falConfigured).toBe(true);
  expect(state.fetch).not.toHaveBeenCalled();
});
it("preserves owner deployment video readiness and existing owner-only creation access", async () => {
  expect((await videoAction(request({ action: "generate-video" }), context)).status).toBe(403);
  state.deps!.principal = owner;
  expect((await (await videoInfo(request({}), context)).json()).falConfigured).toBe(true);
  state.fetch.mockResolvedValueOnce(Response.json({ request_id: "fixture-request" }));
  expect((await videoAction(request({ action: "generate-video", package: {} }), context)).status).toBe(200);
  expect(state.fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Key environment-fal" });
});
it("uses the owner's personal fal.ai key without requiring unused model credentials", async () => {
  state.deps!.principal = owner;
  vi.stubEnv("NEWSBEE_GEMINI_API_KEY", "");
  await saveCredentialProfile(db, owner, { source: "personal", config: { integrations: { falKey: "personal-fal" } } });
  state.fetch.mockResolvedValueOnce(Response.json({ request_id: "fixture-request" }));
  expect((await videoAction(request({ action: "generate-video", package: {} }), context)).status).toBe(200);
  expect(state.fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Key personal-fal" });
});
it("blocks both video submission and refresh before provider calls when no fal.ai key is available", async () => {
  state.deps!.principal = owner;
  vi.stubEnv("FAL_KEY", "");
  const response = await videoAction(request({ action: "generate-video", package: {} }), context);
  expect(response.status).toBe(403);
  expect(state.savePackage).not.toHaveBeenCalled();
  await db.collection<{ _id: string; location_id: string; story_id: string; status: string; request_id: string }>(COLLECTIONS.videoJobs)
    .insertOne({ _id: "video", location_id: "one", story_id: "story", status: "queued", request_id: "fixture-request" });
  const refresh = await videoAction(request({ action: "refresh-video", videoId: "video" }), context);
  expect(refresh.status).toBe(403);
  expect((await refresh.json()).detail).toContain("fal.ai API key");
  expect(state.fetch).not.toHaveBeenCalled();
});
