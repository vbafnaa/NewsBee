import { beforeEach, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import type { Principal } from "@/pipeline/accounts/identity";
import type { VideoJob } from "@/pipeline/video-production";
import { GET, POST } from "@/app/api/admin/video-production/[locationId]/[storyId]/route";
import {
  GET as releaseGET,
  POST as releasePOST,
} from "@/app/api/admin/publications/[publicationId]/releases/[releaseId]/video/[storyId]/route";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";
import { PublicationAccessDenied } from "@/pipeline/publications/permissions";
import { PublicationLifecycleConflict } from "@/pipeline/publications/lifecycle";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

const mocks = vi.hoisted(() => ({
  adminGuard: vi.fn(),
  pipelineDeps: vi.fn(),
  personalRequestDeps: vi.fn(),
  managedRequestDeps: vi.fn(),
  desktopVideoCredentials: vi.fn(),
  getVideoStory: vi.fn(),
  resolveOutputChannel: vi.fn(),
  resolveOutputChannelForPrincipal: vi.fn(),
  loadPublicationReleaseForDistribution: vi.fn(),
  releaseVideoManagement: vi.fn(),
  generateReleaseVideoPackage: vi.fn(),
  saveReleaseVideoPackage: vi.fn(),
  appendPublicationChangeAudit: vi.fn(),
  assertPublicationWrite: vi.fn(),
  createPublicationVideoJob: vi.fn(),
  requirePublicationCapability: vi.fn(),
  activePublicationSupport: vi.fn(),
  startReleaseVideoUpload: vi.fn(),
  saveReleaseVideoChunk: vi.fn(),
  finishReleaseVideoUpload: vi.fn(),
  currentPrincipal: vi.fn(async () => ({ id: "owner", email: "owner@example.test", role: "owner" })),
  submitFalVideo: vi.fn(),
}));

vi.mock("@/lib/admin-session", () => ({
  operatorGuard: mocks.adminGuard,
  signedInGuard: mocks.adminGuard,
  currentPrincipal: mocks.currentPrincipal,
}));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: mocks.pipelineDeps }));
// Route-unit fakes do not implement deployment authority; its real Mongo fencing is tested separately.
vi.mock("../../../../../shared/restore-maintenance", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../../shared/restore-maintenance")>(),
  withSiteWriter: async <T>(_db: Db, work: () => Promise<T>) => work(),
}));
vi.mock("@/pipeline/accounts/runtime", () => ({
  personalRequestDeps: mocks.personalRequestDeps,
  managedRequestDeps: mocks.managedRequestDeps,
  desktopVideoCredentials: mocks.desktopVideoCredentials,
}));
vi.mock("@/pipeline/connectors/fal-video", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/pipeline/connectors/fal-video")>(),
  submitFalVideo: mocks.submitFalVideo,
}));
vi.mock("@/pipeline/video-production", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/pipeline/video-production")>(),
  getVideoStory: mocks.getVideoStory,
  releaseVideoManagement: mocks.releaseVideoManagement,
  generateReleaseVideoPackage: mocks.generateReleaseVideoPackage,
  saveReleaseVideoPackage: mocks.saveReleaseVideoPackage,
}));
vi.mock("@/pipeline/orchestration/output-channels", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/pipeline/orchestration/output-channels")>(),
  resolveOutputChannel: mocks.resolveOutputChannel,
  resolveOutputChannelForPrincipal: mocks.resolveOutputChannelForPrincipal,
}));
vi.mock("@/pipeline/publications/releases", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/pipeline/publications/releases")>(),
  loadPublicationReleaseForDistribution: mocks.loadPublicationReleaseForDistribution,
}));
vi.mock("@/pipeline/publications/access", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/pipeline/publications/access")>(),
  assertPublicationWrite: mocks.assertPublicationWrite,
}));
vi.mock("@/pipeline/publications/lifecycle", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/pipeline/publications/lifecycle")>(),
  ensurePublicationGovernance: vi.fn(async () => undefined),
}));
vi.mock("@/pipeline/publications/media-start", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/pipeline/publications/media-start")>(),
  createPublicationVideoJob: mocks.createPublicationVideoJob,
}));
vi.mock("@/pipeline/publications/audit", () => ({
  appendPublicationChangeAudit: mocks.appendPublicationChangeAudit,
}));
vi.mock("@/pipeline/publications/support", () => ({
  activePublicationSupport: mocks.activePublicationSupport,
}));
vi.mock("@/pipeline/publications/permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/pipeline/publications/permissions")>(),
  requirePublicationCapability: mocks.requirePublicationCapability,
}));
vi.mock("@/pipeline/video-upload", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/pipeline/video-upload")>(),
  startReleaseVideoUpload: mocks.startReleaseVideoUpload,
  saveReleaseVideoChunk: mocks.saveReleaseVideoChunk,
  finishReleaseVideoUpload: mocks.finishReleaseVideoUpload,
}));

const params = { locationId: "moses-lake-wa", storyId: "ed1bcb59e882" };
const request = () => new Request(`https://journalist.example/api/admin/video-production/${params.locationId}/${params.storyId}`);
const releaseParams = {
  publicationId: "a".repeat(32),
  releaseId: "release-1",
  storyId: "release-story",
};
const releaseRequest = (query = "") => new Request(
  `https://journalist.example/api/admin/publications/${releaseParams.publicationId}/releases/${releaseParams.releaseId}/video/${releaseParams.storyId}${query}`,
);
const releasePackage = {
  youtubeTitle: "Release story",
  youtubeDescription: "Release description",
  youtubeTags: ["local"],
  tiktokCaption: "Release caption",
  spokenScript: "Release script",
  videoPrompt: "Release prompt",
  subtitlesSrt: "",
  generatedAt: 1,
  updatedAt: 1,
};

function matches(row: Record<string, unknown>, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return (expected as Record<string, unknown>[]).some((candidate) => matches(row, candidate));
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      const query = expected as Record<string, unknown>;
      if ("$exists" in query) return (key in row) === query.$exists;
      if ("$in" in query) return (query.$in as unknown[]).includes(row[key]);
      if ("$lte" in query) return Number(row[key]) <= Number(query.$lte);
    }
    return row[key] === expected;
  });
}

function releaseFixture(principal: Principal = { id: "editor", email: "editor@example.test", role: "editor" }) {
  const jobs: Record<string, unknown>[] = [];
  const fundingAudit = vi.fn();
  const jobCollection = {
    insertOne: vi.fn(async (job: Record<string, unknown>) => { jobs.push(structuredClone(job)); }),
    findOne: vi.fn(async (filter: Record<string, unknown>) => jobs.find((job) => matches(job, filter)) ?? null),
    updateOne: vi.fn(async (filter: Record<string, unknown>, update: {
      $set?: Record<string, unknown>;
      $unset?: Record<string, unknown>;
    }) => {
      const job = jobs.find((candidate) => matches(candidate, filter));
      if (!job) return { modifiedCount: 0 };
      Object.assign(job, update.$set ?? {});
      for (const key of Object.keys(update.$unset ?? {})) delete job[key];
      return { modifiedCount: 1 };
    }),
    find: vi.fn((filter: Record<string, unknown>) => ({
      sort: () => ({
        toArray: async () => jobs.filter((job) => matches(job, filter)).map((job) => structuredClone(job)),
      }),
    })),
  };
  const db = {
    collection: (name: string) => name === COLLECTIONS.videoJobs
      ? jobCollection
      : { insertOne: fundingAudit },
  };
  const scope = {
    publicationId: releaseParams.publicationId,
    releaseId: releaseParams.releaseId,
    releaseHash: "release-hash",
    item: {
      item_id: releaseParams.storyId,
      location_ids: ["local"],
      location_names: ["Local"],
      headline: "Release story",
      blurb: "Release summary",
      when_where: "Local",
      event_date: "2026-11-17",
      source_url: null,
    },
    release: { publication: { display_name: "Fixture publication" } },
  };
  mocks.currentPrincipal.mockResolvedValue(principal);
  mocks.pipelineDeps.mockResolvedValue({ db, store: { kind: "local" } });
  mocks.resolveOutputChannel.mockResolvedValue({
    context: { id: releaseParams.publicationId },
    channel: { videoPromptTemplate: "Fixture {{dialogue}}" },
  });
  mocks.resolveOutputChannelForPrincipal.mockResolvedValue({
    context: { id: releaseParams.publicationId },
    channel: { videoPromptTemplate: "Fixture {{dialogue}}" },
  });
  mocks.loadPublicationReleaseForDistribution.mockResolvedValue({
    payload: { ...scope.release, items: [scope.item] },
    contentHash: scope.releaseHash,
  });
  mocks.releaseVideoManagement.mockImplementation(async () => ({
    story: { title: "Release story", summary: "Release summary", locationName: "Local" },
    package: releasePackage,
    packageRevision: 1,
    packageHash: "package-hash",
    cacheHash: "cache-hash",
    releaseHash: scope.releaseHash,
    videos: jobs.map((job) => structuredClone(job)),
  }));
  mocks.saveReleaseVideoPackage.mockResolvedValue(releasePackage);
  mocks.managedRequestDeps.mockResolvedValue({ discoveryModel: { provider: "managed" } });
  mocks.personalRequestDeps.mockResolvedValue({
    settings: { integrations: { falKey: "personal-fal-key" } },
    credentialVersion: 7,
  });
  const managedCredential = {
    key: "managed-desktop-key",
    fundingIdentity: "managed" as const,
    credentialVersion: 0,
  };
  mocks.desktopVideoCredentials.mockResolvedValue({
    principal,
    selected: managedCredential,
    forJob: (job: Record<string, unknown>) => job.requested_by === principal.id
      && job.funding_identity === "managed"
      ? managedCredential
      : null,
  });
  return { jobs, jobCollection, fundingAudit, principal, scope };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.adminGuard.mockResolvedValue(null);
  mocks.currentPrincipal.mockResolvedValue({ id: "owner", email: "owner@example.test", role: "owner" });
  mocks.requirePublicationCapability.mockImplementation(() => undefined);
  mocks.appendPublicationChangeAudit.mockResolvedValue({});
  mocks.assertPublicationWrite.mockResolvedValue(undefined);
  mocks.createPublicationVideoJob.mockImplementation(async (db: Db, _context: unknown, job: VideoJob, replacementId?: string) => {
    await db.collection<VideoJob>(COLLECTIONS.videoJobs).insertOne(job);
    if (replacementId) await db.collection<VideoJob>(COLLECTIONS.videoJobs).updateOne({
      _id: replacementId, publication_id: job.publication_id, release_id: job.release_id, story_id: job.story_id,
      replaced_by: { $exists: false },
    }, { $set: { replaced_by: job._id, updated_at: Date.now() } });
    return job;
  });
});

it.each(["", "/reader", "https://custom.example.test/reader"])("ignores reader URL setting %j in Video Studio", async (configuredUrl) => {
  vi.stubEnv("NEWSBEE_READER_SITE_URL", configuredUrl);
  try {
    const channelId = "615e45f2b3d74f8ab84fe6ea7fa91e16";
    const story = { ...params, editionId: "edition-1", title: "Story" };
    const videos = [{ _id: "video-1", requested_by: "editor" }];
    const collections = {
      [COLLECTIONS.outputChannels]: {
        findOne: async () => ({
          _id: channelId,
          owner_id: "editor",
          name: "Fixture channel",
          selected_location_ids: [params.locationId],
          publication_scope_version: 1,
        }),
      },
      [COLLECTIONS.videoPackages]: { findOne: async () => null },
      [COLLECTIONS.videoJobs]: { find: () => ({ sort: () => ({ toArray: async () => videos }) }) },
    };
    mocks.adminGuard.mockResolvedValueOnce(null);
    mocks.currentPrincipal.mockResolvedValueOnce({ id: "editor", email: "editor@example.test", role: "editor" });
    mocks.pipelineDeps.mockResolvedValueOnce({ db: {
      collection: (name: keyof typeof collections) => ({
        createIndex: async () => "",
        createIndexes: async () => [],
        indexExists: async () => false,
        ...collections[name],
      }),
    } });
    mocks.personalRequestDeps.mockResolvedValueOnce({ settings: { integrations: {} } });
    mocks.getVideoStory.mockResolvedValueOnce(story);

    const response = await GET(new Request(`${request().url}?channel=${channelId}`), { params: Promise.resolve(params) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      story,
      package: null,
      packagePrompt: expect.stringContaining(
        `Newsbee story URL: https://newsbee-seven.vercel.app/reader?location=${params.locationId}&edition=edition-1&story=${params.storyId}`,
      ),
      videos: [{ ...videos[0], canRefresh: true }],
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("adds the failing stage and story IDs to an authenticated 400 response", async () => {
  mocks.adminGuard.mockResolvedValueOnce(null);
  mocks.pipelineDeps.mockResolvedValueOnce({});
  mocks.personalRequestDeps.mockRejectedValueOnce(new Error("Invalid provider settings: api_key=example-secret"));

  const response = await GET(request(), { params: Promise.resolve(params) });

  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    detail: "Invalid provider settings: api_key=[redacted]",
    stage: "load_personal_settings",
    ...params,
  });
});

it("returns the authentication error before loading any video data", async () => {
  mocks.pipelineDeps.mockClear();
  mocks.adminGuard.mockResolvedValueOnce(Response.json({ detail: "Sign in" }, { status: 401 }));

  const response = await GET(request(), { params: Promise.resolve(params) });

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ detail: "Sign in" });
  expect(mocks.pipelineDeps).not.toHaveBeenCalled();
});

it("downloads a completed video scoped to the requested story", async () => {
  const bytes = new Uint8Array([0, 1, 2, 3]);
  const findOne = vi.fn().mockResolvedValueOnce({ drive_file_id: "file-1" }).mockResolvedValueOnce(null);
  const readBinary = vi.fn().mockResolvedValue(bytes);
  mocks.adminGuard.mockResolvedValue(null);
  mocks.getVideoStory.mockResolvedValue({});
  mocks.pipelineDeps.mockResolvedValue({ db: { collection: () => ({ findOne }) }, store: { readBinary } });
  const download = () => GET(new Request(`${request().url}?download=video-1`), { params: Promise.resolve(params) });

  const response = await download();
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="story-video.mp4"');
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(findOne).toHaveBeenCalledWith({
    _id: "video-1", location_id: params.locationId, story_id: params.storyId, status: "complete",
  });
  expect(readBinary).toHaveBeenCalledWith("file-1");

  expect((await download()).status).toBe(404);
  expect(readBinary).toHaveBeenCalledTimes(1);
});

it("lets an editor submit video with their own settings while protecting YouTube and other accounts' jobs", async () => {
  const editor = { id: "editor", email: "editor@example.test", role: "editor" };
  const jobs = {
    insertOne: vi.fn(),
    updateOne: vi.fn(),
    findOne: vi.fn().mockResolvedValueOnce({ status: "queued", request_id: "fal-1" })
      .mockResolvedValueOnce({ status: "queued", request_id: "fal-other", requested_by: "other" }),
  };
  const packages = { findOne: vi.fn().mockResolvedValue(null), replaceOne: vi.fn() };
  const deps = { db: { collection: (name: string) => name === COLLECTIONS.videoJobs ? jobs : packages } };
  mocks.adminGuard.mockResolvedValue(null);
  mocks.pipelineDeps.mockResolvedValue(deps);
  mocks.getVideoStory.mockResolvedValue({ ...params, editionId: "edition-1" });
  mocks.currentPrincipal.mockResolvedValueOnce(editor).mockResolvedValueOnce(editor).mockResolvedValueOnce(editor);
  mocks.personalRequestDeps.mockClear();
  mocks.personalRequestDeps.mockResolvedValue({ settings: { integrations: { falKey: "editor-key" } } });
  mocks.submitFalVideo.mockResolvedValue("fal-1");
  const post = (body: object) => POST(new Request(request().url, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve(params),
  });

  const response = await post({ action: "generate-video", package: {
    youtubeTitle: "Story", youtubeDescription: "A local story", youtubeTags: ["local"],
    tiktokCaption: "Local story", spokenScript: "Here is the story.", videoPrompt: "Film the newsroom.",
  } });
  expect(response.status).toBe(200);
  expect(mocks.personalRequestDeps).toHaveBeenCalledWith(expect.anything(), editor, undefined, false, false);
  expect(mocks.submitFalVideo).toHaveBeenCalledWith("Film the newsroom.", "editor-key");
  expect(jobs.insertOne).toHaveBeenCalledWith(expect.objectContaining({ requested_by: editor.id, story_id: params.storyId }));
  expect((await post({ action: "refresh-video", videoId: "other-video" })).status).toBe(403);
  expect((await post({ action: "publish-youtube", videoId: "video-1" })).status).toBe(403);
  expect(mocks.personalRequestDeps).toHaveBeenCalledTimes(1);
});

it("queues Desktop Video with the editor's key and records its completed Drive link", async () => {
  const editor = { id: "editor", email: "editor@example.test", role: "editor" };
  const driveUrl = "https://drive.google.com/file/d/drive-1/view?resourcekey=resource-1";
  const fetchJob = vi.fn()
    .mockRejectedValueOnce(new TypeError("Network timeout"))
    .mockResolvedValueOnce(Response.json({ id: "desktop-1", status: "queued" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ status: "running" }))
    .mockResolvedValueOnce(Response.json({ status: "completed", driveFile: { id: "drive-1", url: driveUrl } }));
  let job: Record<string, unknown> = {};
  const jobs = {
    insertOne: vi.fn(async (value: Record<string, unknown>) => { job = value; }),
    updateOne: vi.fn(async (_filter, { $set }) => { job = { ...job, ...$set }; }),
    findOne: vi.fn(async () => job),
  };
  const packages = { findOne: vi.fn().mockResolvedValue(null), replaceOne: vi.fn() };

  mocks.adminGuard.mockResolvedValue(null);
  mocks.currentPrincipal.mockResolvedValueOnce(editor).mockResolvedValueOnce(editor).mockResolvedValueOnce(editor);
  mocks.pipelineDeps.mockResolvedValue({ db: { collection: (name: string) => name === COLLECTIONS.videoJobs ? jobs : packages } });
  mocks.getVideoStory.mockResolvedValue({ ...params, editionId: "edition-1" });
  mocks.personalRequestDeps.mockResolvedValue({ settings: { integrations: { desktopVideoKey: "editor-desktop-key" } } });
  vi.stubGlobal("fetch", fetchJob);
  const post = (body: object) => POST(new Request(request().url, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve(params),
  });
  try {
    const response = await post({ action: "generate-video", provider: "desktop", package: {
      youtubeTitle: "Story", youtubeDescription: "A local story", youtubeTags: ["local"],
      tiktokCaption: "Local story", spokenScript: "Here is the story.", videoPrompt: "Film the newsroom.",
    } });
    expect(response.status).toBe(200);
    const { video } = await response.json();
    expect(video).toMatchObject({ provider: "desktop", status: "queued", request_id: "desktop-1", requested_by: editor.id });
    const jobsUrl = "https://g2minhledesktopasaaervice.vercel.app/api/jobs";
    for (const [url, options] of fetchJob.mock.calls.slice(0, 2)) {
      expect(url).toBe(jobsUrl);
      expect(options.method).toBe("POST");
      expect(options.headers.get("Authorization")).toBe("Bearer editor-desktop-key");
      expect(options.headers.get("Idempotency-Key")).toBe(video._id);
      expect(JSON.parse(options.body)).toEqual({ prompt: "Film the newsroom.", width: 576, height: 1024, seconds: 15 });
    }

    const refresh = () => post({ action: "refresh-video", videoId: video._id });
    expect(await (await refresh()).json()).toMatchObject({ video: { status: "processing" } });
    expect(await (await refresh()).json()).toMatchObject({ video: { status: "complete", drive_url: driveUrl } });
    expect(fetchJob).toHaveBeenLastCalledWith(`${jobsUrl}/desktop-1`, expect.objectContaining({ method: "GET" }));
  } finally {
    vi.unstubAllGlobals();
  }
});

it("uses the managed runtime for release packages and enforces publication capability before paid work", async () => {
  const fixture = releaseFixture();
  const post = (body: object) => releasePOST(new Request(releaseRequest().url, {
    method: "POST",
    body: JSON.stringify(body),
  }), { params: Promise.resolve(releaseParams) });

  expect((await post({
    action: "generate-content",
    expectedRevision: 1,
    expectedPackageHash: "package-hash",
  })).status).toBe(200);
  expect(mocks.managedRequestDeps).toHaveBeenCalledWith(
    expect.objectContaining({ db: expect.anything() }),
    fixture.principal,
    {
      runId: `release-video-package:${releaseParams.publicationId}:${releaseParams.releaseId}:${releaseParams.storyId}`,
      role: "release-video-package",
      publicationId: releaseParams.publicationId,
    },
  );
  expect(mocks.generateReleaseVideoPackage).toHaveBeenCalledWith(
    expect.anything(),
    { provider: "managed" },
    expect.objectContaining({ publicationId: releaseParams.publicationId, releaseId: releaseParams.releaseId }),
    "Fixture {{dialogue}}",
    { revision: 1, packageHash: "package-hash" },
  );
  expect(mocks.personalRequestDeps).not.toHaveBeenCalled();

  mocks.desktopVideoCredentials.mockClear();
  mocks.requirePublicationCapability.mockImplementationOnce(() => {
    throw new ExecutionBlocked("Publication video generation is not allowed.");
  });

  const denied = await post({
    action: "generate-video",
    provider: "desktop",
    package: releasePackage,
    expectedRevision: 1,
    expectedPackageHash: "package-hash",
  });
  expect(denied.status).toBe(403);
  expect(mocks.desktopVideoCredentials).not.toHaveBeenCalled();
});

it.each([
  { id: "owner", email: "owner@example.test", role: "owner" as const },
  { id: "admin", email: "admin@example.test", role: "admin" as const },
])("uses explicit audited operator support scope for $role release video work", async (principal) => {
  releaseFixture(principal);
  const response = await releasePOST(new Request(releaseRequest().url, {
    method: "POST",
    body: JSON.stringify({
      action: "generate-content",
      expectedRevision: 1,
      expectedPackageHash: "package-hash",
    }),
  }), { params: Promise.resolve(releaseParams) });
  expect(response.status).toBe(200);
  expect(mocks.resolveOutputChannelForPrincipal).toHaveBeenCalledWith(
    expect.anything(),
    principal,
    releaseParams.publicationId,
    "Change publication video production from the support workspace",
    "write",
  );
  expect(mocks.assertPublicationWrite).toHaveBeenCalledWith(
    expect.anything(), expect.objectContaining({ id: releaseParams.publicationId }), "publication_video_operation",
  );
});

it("rejects release video work when the resolved context has no valid write authority before provider work", async () => {
  releaseFixture();
  mocks.assertPublicationWrite.mockRejectedValueOnce(new PublicationAccessDenied());
  const response = await releasePOST(new Request(releaseRequest().url, {
    method: "POST", body: JSON.stringify({ action: "generate-content", expectedRevision: 1, expectedPackageHash: "package-hash" }),
  }), { params: Promise.resolve(releaseParams) });
  expect(response.status).toBe(403);
  expect(mocks.generateReleaseVideoPackage).not.toHaveBeenCalled();
  expect(mocks.managedRequestDeps).not.toHaveBeenCalled();
});

it("does not submit provider work after a concurrent ownership/lifecycle change rejects the active-job transaction", async () => {
  releaseFixture();
  mocks.createPublicationVideoJob.mockRejectedValueOnce(new PublicationLifecycleConflict());
  const response = await releasePOST(new Request(releaseRequest().url, {
    method: "POST", body: JSON.stringify({
      action: "generate-video", provider: "fal", package: releasePackage, expectedRevision: 1, expectedPackageHash: "package-hash",
    }),
  }), { params: Promise.resolve(releaseParams) });
  expect(response.status).toBe(409);
  expect(mocks.submitFalVideo).not.toHaveBeenCalled();
});

it("keeps an unassigned editor outside cross-publication release video scope", async () => {
  releaseFixture();
  mocks.resolveOutputChannelForPrincipal.mockResolvedValue(null);
  const response = await releaseGET(releaseRequest(), { params: Promise.resolve(releaseParams) });
  expect(response.status).toBe(404);
  expect(mocks.managedRequestDeps).not.toHaveBeenCalled();
  expect(mocks.personalRequestDeps).not.toHaveBeenCalled();
});

it("submits and completes a managed release Desktop job with safe attribution and Drive-only handoff", async () => {
  const fixture = releaseFixture();
  const fetchJob = vi.fn()
    .mockResolvedValueOnce(Response.json({ id: "desktop-release-1", status: "queued" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({
      status: "completed",
      driveFile: { id: "drive-release-1", url: "https://evil.example.test/stolen.mp4" },
    }));
  vi.stubGlobal("fetch", fetchJob);
  const post = (body: object) => releasePOST(new Request(releaseRequest().url, {
    method: "POST",
    body: JSON.stringify(body),
  }), { params: Promise.resolve(releaseParams) });
  try {
    const submitted = await post({
      action: "generate-video",
      provider: "desktop",
      package: releasePackage,
      expectedRevision: 1,
      expectedPackageHash: "package-hash",
    });
    expect(submitted.status).toBe(200);
    const created = (await submitted.json()).video;
    expect(created).toMatchObject({
      provider: "desktop",
      funding_identity: "managed",
      status: "queued",
    });
    expect(created).not.toHaveProperty("credential_owner_id");
    expect(created).not.toHaveProperty("credential_version");
    expect(created).not.toHaveProperty("request_id");
    expect(created).not.toHaveProperty("requested_by");
    expect(fixture.jobs[0]).toMatchObject({
      credential_version: 0,
      requested_by: fixture.principal.id,
      request_id: "desktop-release-1",
    });
    expect(JSON.stringify(created)).not.toContain("managed-desktop-key");
    expect(fetchJob).toHaveBeenNthCalledWith(1,
      "https://g2minhledesktopasaaervice.vercel.app/api/jobs",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchJob.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer managed-desktop-key");

    const refreshed = await post({ action: "refresh-video", videoId: created._id });
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).video).toMatchObject({
      status: "complete",
      drive_url: "https://drive.google.com/file/d/drive-release-1/view",
    });
    expect(fixture.fundingAudit).toHaveBeenCalledWith(expect.objectContaining({
      sponsor_id: fixture.principal.id,
      funding: "platform",
      funding_identity: "managed",
      provider: "desktop",
      model: "minimax-h3",
    }));
    expect(JSON.stringify(fixture.fundingAudit.mock.calls)).not.toContain("managed-desktop-key");
    expect(mocks.appendPublicationChangeAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "video_generation_completed",
      principal_id: fixture.principal.id,
    }));
    expect(fixture.jobs[0]).not.toHaveProperty("drive_file_id");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not poll an inaccessible personal Desktop job and replaces it only on explicit action", async () => {
  const fixture = releaseFixture();
  fixture.jobs.push({
    _id: "legacy-desktop",
    publication_id: releaseParams.publicationId,
    release_id: releaseParams.releaseId,
    release_hash: fixture.scope.releaseHash,
    story_id: releaseParams.storyId,
    location_id: "local",
    edition_id: releaseParams.releaseId,
    prompt: "Legacy prompt",
    provider: "desktop",
    funding_identity: "personal",
    credential_owner_id: fixture.principal.id,
    credential_version: 4,
    requested_by: fixture.principal.id,
    request_id: "legacy-provider-id",
    status: "queued",
    created_at: 1,
    updated_at: 1,
  });
  const fetchJob = vi.fn();
  vi.stubGlobal("fetch", fetchJob);
  const post = (body: object) => releasePOST(new Request(releaseRequest().url, {
    method: "POST",
    body: JSON.stringify(body),
  }), { params: Promise.resolve(releaseParams) });
  try {
    const unavailable = await post({ action: "refresh-video", videoId: "legacy-desktop" });
    expect(unavailable.status).toBe(200);
    expect((await unavailable.json()).video).toMatchObject({
      _id: "legacy-desktop",
      legacyUnavailable: true,
      canReplace: true,
      canRefresh: false,
    });
    expect(fetchJob).not.toHaveBeenCalled();

    fetchJob.mockResolvedValueOnce(Response.json({ id: "replacement-provider-id", status: "queued" }, { status: 201 }));
    const replacement = await post({
      action: "replace-video",
      videoId: "legacy-desktop",
      package: releasePackage,
      expectedRevision: 1,
      expectedPackageHash: "package-hash",
    });
    expect(replacement.status).toBe(200);
    const created = (await replacement.json()).video;
    expect(created).toMatchObject({
      replacement_of: "legacy-desktop",
      funding_identity: "managed",
    });
    expect(created).not.toHaveProperty("request_id");
    expect(created).not.toHaveProperty("credential_owner_id");
    expect(created).not.toHaveProperty("credential_version");
    expect(fixture.jobs.find((job) => job._id === "legacy-desktop")).toMatchObject({
      replaced_by: created._id,
      request_id: "legacy-provider-id",
    });
    expect(fetchJob).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("returns role-aware readiness and redacts credential and provider internals from release history", async () => {
  const fixture = releaseFixture();
  fixture.jobs.push({
    _id: "safe-history",
    publication_id: releaseParams.publicationId,
    release_id: releaseParams.releaseId,
    release_hash: fixture.scope.releaseHash,
    story_id: releaseParams.storyId,
    location_id: "local",
    edition_id: releaseParams.releaseId,
    prompt: "Private provider prompt",
    provider: "desktop",
    funding_identity: "managed",
    credential_owner_id: fixture.principal.id,
    credential_version: 9,
    requested_by: fixture.principal.id,
    request_id: "private-provider-request",
    status: "queued",
    created_at: 1,
    updated_at: 1,
  });

  const response = await releaseGET(releaseRequest(), { params: Promise.resolve(releaseParams) });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data).toMatchObject({
    principalRole: "editor",
    desktopConfigured: true,
    desktopFunding: "managed",
    videos: [{ _id: "safe-history", provider: "desktop", funding_identity: "managed", canRefresh: true }],
  });
  expect(JSON.stringify(data)).not.toContain("credential_owner_id");
  expect(JSON.stringify(data)).not.toContain("credential_version");
  expect(JSON.stringify(data)).not.toContain("private-provider-request");
  expect(JSON.stringify(data)).not.toContain("Private provider prompt");
});

it("does not direct editors to personal fal.ai settings when fal.ai is unavailable", async () => {
  releaseFixture();
  mocks.personalRequestDeps.mockRejectedValueOnce(new ExecutionBlocked("Add your personal fal.ai API key in Environment & API settings."));

  const response = await releaseGET(releaseRequest(), { params: Promise.resolve(releaseParams) });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data).toMatchObject({
    principalRole: "editor",
    falConfigured: false,
    falUnavailableReason: expect.stringContaining("Use Newsbee-managed Desktop Video"),
  });

  expect(JSON.stringify(data)).not.toContain("personal fal.ai API key");

  mocks.personalRequestDeps.mockRejectedValueOnce(new ExecutionBlocked("Add your personal fal.ai API key in Environment & API settings."));
  const submitted = await releasePOST(new Request(releaseRequest().url, {
    method: "POST",
    body: JSON.stringify({
      action: "generate-video",
      provider: "fal",
      package: releasePackage,
      expectedRevision: 1,
      expectedPackageHash: "package-hash",
    }),
  }), { params: Promise.resolve(releaseParams) });
  expect(submitted.status).toBe(403);
  expect(await submitted.json()).toMatchObject({
    detail: expect.stringContaining("Use Newsbee-managed Desktop Video"),
  });
});

it.each([
  { role: "editor", contextRole: "editor", archivedAt: null, support: null, canWrite: true },
  { role: "admin", contextRole: "editor", archivedAt: null, support: null, canWrite: true },
  { role: "admin", contextRole: "privileged", archivedAt: null, support: null, canWrite: false },
  { role: "admin", contextRole: "privileged", archivedAt: null, support: { expires_at: 4_000_000_000_000 }, canWrite: true },
  { role: "owner", contextRole: "owner", archivedAt: 1, support: null, canWrite: false },
] as const)("returns authoritative video write capability for $role/$contextRole archived=$archivedAt", async ({ role, contextRole, archivedAt, support, canWrite }) => {
  const fixture = releaseFixture({ id: "actor", email: "actor@example.test", role });
  mocks.resolveOutputChannelForPrincipal.mockResolvedValue({
    context: { id: releaseParams.publicationId, role: contextRole },
    channel: { videoPromptTemplate: "Fixture {{dialogue}}", archivedAt },
  });
  mocks.activePublicationSupport.mockResolvedValue(support);
  const response = await releaseGET(releaseRequest(), { params: Promise.resolve(releaseParams) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    principalRole: role, canWrite, supportExpiresAt: support?.expires_at ?? null,
  });
  expect(mocks.managedRequestDeps).not.toHaveBeenCalled();
  expect(mocks.generateReleaseVideoPackage).not.toHaveBeenCalled();
  expect(mocks.submitFalVideo).not.toHaveBeenCalled();
  expect(fixture.jobs).toHaveLength(0);
});

it("passes publication, release and story scope through release upload start, chunk and finish", async () => {
  const fixture = releaseFixture();
  mocks.startReleaseVideoUpload.mockResolvedValue({ uploadId: "upload-1" });
  mocks.finishReleaseVideoUpload.mockResolvedValue({
    _id: "uploaded-video",
    publication_id: releaseParams.publicationId,
    release_id: releaseParams.releaseId,
    story_id: releaseParams.storyId,
    status: "complete",
    source: "upload",
  });
  const post = (body: object, query = "") => releasePOST(new Request(releaseRequest(query).url, {
    method: "POST",
    headers: query ? { "Content-Type": "application/octet-stream", "Content-Length": "1" } : undefined,
    body: query ? new Uint8Array([1]) : JSON.stringify(body),
  }), { params: Promise.resolve(releaseParams) });

  expect((await post({ action: "start-upload", size: 12 })).status).toBe(200);
  expect(mocks.startReleaseVideoUpload).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ publicationId: releaseParams.publicationId, releaseId: releaseParams.releaseId }),
    fixture.principal.id,
    12,
    expect.objectContaining({ id: releaseParams.publicationId }),
  );
  expect((await post({}, "?action=upload-chunk&uploadId=upload-1&index=0")).status).toBe(200);
  expect(mocks.saveReleaseVideoChunk).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ publicationId: releaseParams.publicationId, releaseId: releaseParams.releaseId }),
    fixture.principal.id,
    "upload-1",
    0,
    new Uint8Array([1]),
  );
  expect((await post({ action: "finish-upload", uploadId: "upload-1" })).status).toBe(200);
  expect(mocks.desktopVideoCredentials).toHaveBeenLastCalledWith(
    expect.anything(), fixture.principal, releaseParams.publicationId,
  );
  expect(mocks.finishReleaseVideoUpload).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ publicationId: releaseParams.publicationId, releaseId: releaseParams.releaseId }),
    releasePackage,
    "Fixture {{dialogue}}",
    fixture.principal.id,
    "upload-1",
    expect.objectContaining({ id: releaseParams.publicationId }),
  );
});
