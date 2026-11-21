import { beforeEach, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { GET, POST } from "@/app/api/admin/video-campaigns/route";
import { campaignCopy, VIDEO_CAMPAIGNS, type VideoCampaign } from "@/pipeline/campaigns/video-campaigns";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(), principal: vi.fn(), deps: vi.fn(), policy: vi.fn(), generation: vi.fn(),
  submit: vi.fn(), status: vi.fn(), result: vi.fn(), writer: vi.fn(),
}));
vi.mock("@/lib/admin-session", () => ({
  operatorGuard: mocks.guard, currentPrincipal: mocks.principal, currentRestoreGeneration: mocks.generation,
}));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: mocks.deps }));
vi.mock("@/pipeline/accounts/execution", () => ({ resolveExecutionProviderPolicy: mocks.policy }));
vi.mock("@/pipeline/connectors/fal-video", async (original) => ({
  ...await original<typeof import("@/pipeline/connectors/fal-video")>(),
  submitFalVideo: mocks.submit, falVideoStatus: mocks.status, falVideoResult: mocks.result,
}));
vi.mock("../../../../../shared/restore-maintenance", async (original) => ({
  ...await original<typeof import("../../../../../shared/restore-maintenance")>(),
  withSiteWriter: mocks.writer,
}));

const principal = { id: "admin-a", email: "admin-a@example.test", role: "admin" };
const copy = { title: "Pilot invitation", brief: "Invite reporters to request access.", script: "Bring your reporting together. Request early access.", caption: "Request access to the pilot.", prompt: "An abstract workspace with soft light. No people or brands." };
const url = "https://newsbee.example/api/admin/video-campaigns";
let rows: VideoCampaign[];
let db: Db;
let store: { kind: "local"; ensureFolder: ReturnType<typeof vi.fn>; saveBinary: ReturnType<typeof vi.fn>; readBinary: ReturnType<typeof vi.fn> };

function valueAt(row: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, row);
}
function matches(row: VideoCampaign, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return (expected as Record<string, unknown>[]).some((alternative) => matches(row, alternative));
    const actual = valueAt(row, key);
    if (expected && typeof expected === "object") {
      if ("$exists" in expected) return (actual !== undefined) === expected.$exists;
      if ("$in" in expected) return (expected.$in as unknown[]).includes(actual);
    }
    return expected === actual;
  });
}
const request = (body: object) => POST(new Request(url, { method: "POST", headers: { origin: "https://newsbee.example", "content-type": "application/json" }, body: JSON.stringify(body) }));
async function saved() {
  const response = await request({ action: "save", copy });
  expect(response.status).toBe(200);
  return (await response.json()).campaign as VideoCampaign;
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  const collection = {
    insertOne: vi.fn(async (row: VideoCampaign) => { rows.push(structuredClone(row)); }),
    findOne: vi.fn(async (filter: Record<string, unknown>) => structuredClone(rows.find((row) => matches(row, filter)) ?? null)),
    findOneAndUpdate: vi.fn(async (filter: Record<string, unknown>, update: { $set?: Record<string, unknown>; $inc?: { revision: number } }) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return null;
      Object.assign(row, structuredClone(update.$set));
      if (update.$inc) row.revision += update.$inc.revision;
      return structuredClone(row);
    }),
    find: vi.fn((filter: Record<string, unknown>) => ({
      sort: () => ({ limit: () => ({ toArray: async () => structuredClone(rows.filter((row) => matches(row, filter))) }) }),
    })),
  };
  db = { collection: (name: string) => name === VIDEO_CAMPAIGNS ? collection : { insertOne: vi.fn(async () => undefined) } } as unknown as Db;
  store = { kind: "local", ensureFolder: vi.fn(async (parent: string, name: string) => `${parent}/${name}`), saveBinary: vi.fn(async () => "private-video-id"), readBinary: vi.fn(async () => new Uint8Array([0, 1, 2])) };
  mocks.deps.mockResolvedValue({ db, settings: {}, store });
  mocks.guard.mockResolvedValue(null);
  mocks.principal.mockResolvedValue(principal);
  mocks.generation.mockResolvedValue("generation-1");
  mocks.policy.mockResolvedValue({ principal, credentialVersion: 7, source: "personal", settings: { integrations: { falKey: "test-private-fal-key" } } });
  mocks.writer.mockImplementation(async (_db: Db, work: () => Promise<unknown>) => work());
  mocks.submit.mockResolvedValue("fal-request-private");
  mocks.status.mockResolvedValue({ status: "IN_QUEUE" });
  mocks.result.mockResolvedValue({ content: new Uint8Array([0, 1, 2]), mimeType: "video/mp4" });
});

it("saves editable drafts without provider calls, rejects stale saves and bounds untrusted copy", async () => {
  const campaign = await saved();
  expect(rows[0]).toMatchObject({ createdBy: principal.id, revision: 1, ...copy });
  expect(mocks.submit).not.toHaveBeenCalled();
  const changed = await request({ action: "save", id: campaign._id, revision: 1, copy: { ...copy, script: "Updated script." } });
  expect(changed.status).toBe(200);
  expect((await request({ action: "save", id: campaign._id, revision: 1, copy })).status).toBe(409);
  expect(() => campaignCopy({ ...copy, title: { $ne: null } })).toThrow("Invalid campaign title");
  expect(() => campaignCopy({ ...copy, prompt: "x".repeat(6001) })).toThrow();
  expect(mocks.writer).toHaveBeenCalled();
});

it("admits only one of concurrent or replayed paid requests and keeps provider identity private", async () => {
  const campaign = await saved();
  const body = { action: "render", id: campaign._id, revision: 1, confirmPaid: true };
  const responses = await Promise.all([request(body), request(body)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.submit).toHaveBeenCalledWith(expect.stringContaining(copy.script), "test-private-fal-key");
  expect(mocks.submit.mock.calls[0][0]).not.toContain(copy.brief);
  const publicResult = await responses.find((response) => response.status === 200)!.json();
  expect(JSON.stringify(publicResult)).not.toMatch(/test-private-fal-key|fal-request-private|credentialVersion|identityGeneration/);
  expect((await request(body)).status).toBe(409);
});

it("rejects supplied non-exact save IDs before any campaign query or write", async () => {
  const campaign = await saved();
  const before = structuredClone(rows);
  const collection = vi.spyOn(db, "collection");
  for (const id of [{ $ne: null }, { $in: [campaign._id] }, [], [campaign._id], null, false, 0, "", "   ", "x".repeat(101)]) {
    const response = await request({ action: "save", id, revision: 1, copy: { ...copy, title: "Must not save" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ detail: "Invalid campaign ID." });
  }
  expect(collection).not.toHaveBeenCalled();
  expect(rows).toEqual(before);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("keeps ambiguous submission blocked rather than silently making a second paid request", async () => {
  const campaign = await saved();
  mocks.submit.mockRejectedValue(new Error("network timeout test-private-fal-key"));
  const response = await request({ action: "render", id: campaign._id, revision: 1, confirmPaid: true });
  const result = await response.json();
  expect(result.campaign.render).toMatchObject({ status: "submitting", error: expect.stringContaining("outcome uncertain") });
  expect(JSON.stringify(result)).not.toContain("test-private-fal-key");
  expect((await request({ action: "render", id: campaign._id, revision: 2, confirmPaid: true })).status).toBe(409);
  expect((await request({ action: "refresh", id: campaign._id })).status).toBe(409);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
});

it("refreshes the same request, retains retriable retrieval failures, and privately downloads a real stored result", async () => {
  const campaign = await saved();
  await request({ action: "render", id: campaign._id, revision: 1, confirmPaid: true });
  mocks.status.mockResolvedValue({ status: "COMPLETED" });
  mocks.result.mockRejectedValueOnce(new Error("download interrupted"));
  const failed = await (await request({ action: "refresh", id: campaign._id })).json();
  expect(failed.campaign.render).toMatchObject({ status: "queued", error: expect.stringContaining("Refresh failed") });
  const complete = await (await request({ action: "refresh", id: campaign._id })).json();
  expect(complete.campaign.render).toMatchObject({ status: "complete", downloadable: true });
  expect(store.saveBinary).toHaveBeenCalledWith(expect.stringContaining(campaign._id), "campaign.mp4", new Uint8Array([0, 1, 2]), "video/mp4");
  const download = await GET(new Request(`${url}?download=${campaign._id}`));
  expect(download.headers.get("cache-control")).toBe("private, no-store");
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([0, 1, 2]);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.status).toHaveBeenCalledWith("fal-request-private", "test-private-fal-key");
});

it("requires explicit paid consent and credentials and blocks restored/changed funding identity", async () => {
  const campaign = await saved();
  expect((await request({ action: "render", id: campaign._id, revision: 1 })).status).toBe(400);
  mocks.policy.mockRejectedValueOnce(new ExecutionBlocked("Add your personal key."));
  expect((await request({ action: "render", id: campaign._id, revision: 1, confirmPaid: true })).status).toBe(403);
  expect(mocks.submit).not.toHaveBeenCalled();
  await request({ action: "render", id: campaign._id, revision: 1, confirmPaid: true });
  mocks.generation.mockResolvedValueOnce("restored-generation");
  expect((await request({ action: "refresh", id: campaign._id })).status).toBe(403);
  mocks.policy.mockResolvedValueOnce({ principal, credentialVersion: 8, source: "personal", settings: { integrations: { falKey: "changed" } } });
  expect((await request({ action: "refresh", id: campaign._id })).status).toBe(403);
  expect(mocks.status).not.toHaveBeenCalled();
});

it("denies cross-actor reads/writes/downloads and excludes Journalists even behind the operator wrapper", async () => {
  const campaign = await saved();
  mocks.principal.mockResolvedValue({ ...principal, id: "admin-b" });
  expect((await GET(new Request(url))).status).toBe(200);
  expect((await (await GET(new Request(url))).json()).campaigns).toEqual([]);
  expect((await GET(new Request(`${url}?download=${campaign._id}`))).status).toBe(404);
  expect((await request({ action: "save", id: campaign._id, revision: 1, copy })).status).toBe(409);
  expect((await request({ action: "render", id: campaign._id, revision: 1, confirmPaid: true })).status).toBe(404);
  mocks.principal.mockResolvedValue({ ...principal, role: "editor" });
  expect((await GET(new Request(url))).status).toBe(403);
  expect((await request({ action: "save", copy })).status).toBe(403);
  mocks.guard.mockResolvedValueOnce(Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 }));
  expect((await request({ action: "save", copy })).status).toBe(403);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("exposes disabled provider state on private reads without contacting any provider", async () => {
  await saved();
  mocks.policy.mockRejectedValue(new ExecutionBlocked("Personal API credentials were revoked."));
  const response = await GET(new Request(url));
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ configured: false, unavailableReason: "Personal API credentials were revoked.", campaigns: [{ title: copy.title }] });
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.status).not.toHaveBeenCalled();
});
