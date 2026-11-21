import { jsonBody, publicationRoute } from "@/lib/admin-api";
import type { Principal } from "@/pipeline/accounts/identity";
import { desktopVideoCredentials, managedRequestDeps, personalRequestDeps } from "@/pipeline/accounts/runtime";
import { checkDesktopVideo, submitDesktopVideo } from "@/pipeline/connectors/desktop-video";
import { falVideoConfigured, falVideoModel, falVideoResult, falVideoStatus, submitFalVideo } from "@/pipeline/connectors/fal-video";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";
import { safeError } from "@/pipeline/core/redaction";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { assertPublicationWrite } from "@/pipeline/publications/access";
import { createPublicationVideoJob } from "@/pipeline/publications/media-start";
import type { OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { appendPublicationChangeAudit } from "@/pipeline/publications/audit";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { activePublicationSupport } from "@/pipeline/publications/support";
import { loadPublicationReleaseForDistribution } from "@/pipeline/publications/releases";
import { runFolder } from "@/pipeline/storage/artifacts";
import { COLLECTIONS } from "@/pipeline/storage/mongo";
import {
  generateReleaseVideoPackage,
  newReleaseVideoJob,
  ReleaseVideoPackageConflict,
  releaseVideoManagement,
  saveReleaseVideoPackage,
  type ReleaseVideoScope,
  type VideoJob,
  type VideoProvider,
} from "@/pipeline/video-production";
import {
  finishReleaseVideoUpload,
  saveReleaseVideoChunk,
  startReleaseVideoUpload,
  VIDEO_UPLOAD_CHUNK_BYTES,
} from "@/pipeline/video-upload";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ publicationId: string; releaseId: string; storyId: string }> };
type ActionBody = {
  action?: string;
  package?: unknown;
  provider?: VideoProvider;
  videoId?: string;
  uploadId?: string;
  size?: number;
  expectedRevision?: number;
  expectedPackageHash?: string;
};

function expectedPackage(body: ActionBody) {
  if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision ?? -1) < 0 || typeof body.expectedPackageHash !== "string") {
    throw new ReleaseVideoPackageConflict("Reload the release video package before changing it.");
  }
  return { revision: body.expectedRevision!, packageHash: body.expectedPackageHash };
}

function jobCollection(db: import("mongodb").Db) {
  return db.collection<VideoJob>(COLLECTIONS.videoJobs);
}

async function updateJob(db: import("mongodb").Db, id: string, scope: ReleaseVideoScope, update: Partial<VideoJob>) {
  await jobCollection(db).updateOne(
    { _id: id, publication_id: scope.publicationId, release_id: scope.releaseId, story_id: scope.item.item_id },
    { $set: { ...update, updated_at: Date.now() } },
  );
  return jobCollection(db).findOne({
    _id: id,
    publication_id: scope.publicationId,
    release_id: scope.releaseId,
    story_id: scope.item.item_id,
  });
}

type DesktopCredentials = Awaited<ReturnType<typeof desktopVideoCredentials>>;
type VideoAccess = ReturnType<typeof videoAccess>;

function videoAccess(video: VideoJob, principal: { id: string; role: string }, desktop: DesktopCredentials | null) {
  if ((video.provider ?? "fal") !== "desktop") {
    return {
      canRefresh: video.requested_by === principal.id || (!video.requested_by && principal.role === "owner"),
      legacyUnavailable: false,
      canReplace: false,
    };
  }
  const active = !["complete", "failed"].includes(video.status);
  const credential = active ? desktop?.forJob(video) ?? null : null;
  const legacyUnavailable = active && video.requested_by === principal.id && !credential;
  return {
    canRefresh: active && Boolean(credential),
    legacyUnavailable,
    canReplace: legacyUnavailable,
  };
}

function publicVideo(video: VideoJob & { stale?: boolean }, access: VideoAccess) {
  return {
    _id: video._id,
    status: video.status,
    source: video.source,
    provider: video.provider,
    funding_identity: video.funding_identity,
    error: video.error,
    stale: video.stale,
    drive_file_id: video.drive_file_id,
    drive_url: video.drive_url,
    replacement_of: video.replacement_of,
    replaced_by: video.replaced_by,
    created_at: video.created_at,
    updated_at: video.updated_at,
    ...access,
  };
}

function publicManagement(
  management: Awaited<ReturnType<typeof releaseVideoManagement>>,
  principal: { id: string; role: string },
  desktop: DesktopCredentials | null,
) {
  return {
    ...management,
    videos: management.videos.map((video) => publicVideo(video, videoAccess(video, principal, desktop))),
  };
}

async function availableDesktop(
  deps: OrchestratorDeps,
  principal: NonNullable<Parameters<typeof desktopVideoCredentials>[1]>,
  publicationId: string,
) {
  return desktopVideoCredentials(deps, principal, publicationId).catch((error: unknown) => {
    if (error instanceof ExecutionBlocked) return null;
    throw error;
  });
}

async function requiredFalRequestDeps(deps: OrchestratorDeps) {
  try {
    return await personalRequestDeps(deps, deps.principal!, undefined, false, false);
  } catch (error) {
    if (error instanceof ExecutionBlocked && deps.principal!.role === "editor") {
      throw new ExecutionBlocked("fal.ai is not enabled for this editor. Use Newsbee-managed Desktop Video or ask the newsroom owner for help.");
    }
    throw error;
  }
}

async function recordReleaseVideoEvent(
  db: import("mongodb").Db,
  scope: ReleaseVideoScope,
  principal: { id: string; email: string },
  job: VideoJob,
  event: "submitted" | "polled" | "completed" | "replaced",
  ok = true,
  reason: string | null = null,
) {
  const fundingIdentity = job.funding_identity ?? "personal";
  const action = {
    submitted: "video_generation_submitted",
    polled: "video_generation_polled",
    completed: "video_generation_completed",
    replaced: "video_generation_replaced",
  } as const;
  await Promise.all([
    db.collection("journalist_funding_audit").insertOne({
      run_id: job._id,
      sponsor_id: principal.id,
      credential_version: job.credential_version ?? 0,
      funding: fundingIdentity === "managed" ? "platform" : "personal",
      funding_identity: fundingIdentity,
      provider: job.provider ?? "fal",
      model: job.provider === "desktop" ? "minimax-h3" : falVideoModel(),
      role: `release-video-${event}`,
      ok,
      reason,
      at: Date.now() / 1000,
    }),
    appendPublicationChangeAudit(db, {
      publication_id: scope.publicationId,
      principal_id: principal.id,
      principal_email: principal.email,
      action: action[event],
      resource_id: job._id,
      detail: `${event} ${(job.provider ?? "fal")} release video generation using ${fundingIdentity} funding for immutable release ${scope.releaseId} story ${scope.item.item_id}`,
      before_hash: null,
      after_hash: scope.releaseHash,
    }),
  ]);
}

async function releaseScope(
  db: import("mongodb").Db,
  principal: Principal,
  publicationId: string,
  releaseId: string,
  storyId: string,
  accessMode: "read" | "write",
) {
  const access = await resolveOutputChannelForPrincipal(
    db,
    principal,
    publicationId,
    accessMode === "read"
      ? "Review publication video production in the support workspace"
      : "Change publication video production from the support workspace",
    accessMode,
  );
  if (!access) return null;
  if (accessMode === "write") await assertPublicationWrite(db, access.context, "publication_video_operation");
  const loaded = await loadPublicationReleaseForDistribution(db, access.context, releaseId);
  const item = loaded.payload.items.find((candidate) => candidate.item_id === storyId);
  if (!item) return null;
  return {
    access,
    scope: {
      publicationId,
      releaseId,
      releaseHash: loaded.contentHash,
      release: loaded.payload,
      item,
    } satisfies ReleaseVideoScope,
  };
}

export async function GET(request: Request, context: Context) {
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:read");
    const { publicationId, releaseId, storyId } = await context.params;
    const loaded = await releaseScope(deps.db, deps.principal!, publicationId, releaseId, storyId, "read");
    if (!loaded) return Response.json({ detail: "Release story was not found." }, { status: 404 });
    const query = new URL(request.url).searchParams;
    const downloadId = query.get("download") ?? query.get("preview");
    if (downloadId) {
      const video = await jobCollection(deps.db).findOne({
        _id: downloadId,
        publication_id: publicationId,
        release_id: releaseId,
        story_id: storyId,
        status: "complete",
      });
      if (!video?.drive_file_id) throw new Error("Unknown video request or video is not ready to download");
      if (!deps.store.readBinary) throw new Error("Video storage does not support downloads");
      const bytes = await deps.store.readBinary(video.drive_file_id);
      return new Response(new Blob([Uint8Array.from(bytes)]).stream(), { headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": query.has("preview")
          ? `inline; filename="${encodeURIComponent(storyId)}-video.mp4"`
          : `attachment; filename="${encodeURIComponent(storyId)}-video.mp4"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      } });
    }
    let falUnavailableReason: string | null = null;
    const personal = await personalRequestDeps(deps, deps.principal!, undefined, false, false).catch((error: unknown) => {
      if (error instanceof ExecutionBlocked) {
        falUnavailableReason = deps.principal!.role === "editor"
          ? "fal.ai is not enabled for this editor. Use Newsbee-managed Desktop Video when it is available."
          : error.message;
        return null;
      }
      throw error;
    });
    const desktop = await availableDesktop(deps, deps.principal!, publicationId);
    const support = loaded.access.context.role === "privileged"
      ? await activePublicationSupport(deps.db, deps.principal!, publicationId) : null;
    const management = await releaseVideoManagement(deps.db, loaded.scope, loaded.access.channel.videoPromptTemplate);
    return {
      ...publicManagement(management, deps.principal!, desktop),
      canWrite: loaded.access.channel.archivedAt == null
        && (loaded.access.context.role !== "privileged" || Boolean(support)),
      supportExpiresAt: support?.expires_at ?? null,
      principalRole: deps.principal!.role,
      falConfigured: personal !== null && falVideoConfigured(personal.settings.integrations.falKey),
      falUnavailableReason,
      desktopConfigured: Boolean(desktop?.selected),
      desktopFunding: desktop?.selected?.fundingIdentity ?? null,
      desktopUnavailableReason: desktop?.selectionUnavailable
        ? "The personal Desktop Video credential cannot be read. Repair it before generating."
        : !desktop?.selected
          ? deps.principal!.role === "admin" ? "Add your personal Desktop Video key in Environment & API settings." : "Newsbee-managed Desktop Video is not configured."
          : null,
      model: falVideoModel(),
    };
  });
}

export async function POST(request: Request, context: Context) {
  return publicationRoute(request, async (deps) => {
    requirePublicationCapability(deps.principal!, "publication:write");
    const { publicationId, releaseId, storyId } = await context.params;
    const loaded = await releaseScope(deps.db, deps.principal!, publicationId, releaseId, storyId, "write");
    if (!loaded) return Response.json({ detail: "Release story was not found." }, { status: 404 });
    const template = loaded.access.channel.videoPromptTemplate;
    const query = new URL(request.url).searchParams;
    if (query.get("action") === "upload-chunk") {
      const uploadId = query.get("uploadId");
      const index = Number(query.get("index"));
      if (!uploadId || !Number.isSafeInteger(index) || index < 0
        || request.headers.get("content-type") !== "application/octet-stream"
        || Number(request.headers.get("content-length")) > VIDEO_UPLOAD_CHUNK_BYTES) {
        throw new Error("Invalid video upload chunk");
      }
      await saveReleaseVideoChunk(
        deps.db,
        loaded.scope,
        deps.principal!.id,
        uploadId,
        index,
        new Uint8Array(await request.arrayBuffer()),
      );
      return { uploaded: true };
    }
    const body = await jsonBody<ActionBody>(request);
    const submitVideo = async (provider: VideoProvider, replacement?: VideoJob) => {
      const content = await saveReleaseVideoPackage(
        deps.db,
        loaded.scope,
        body.package,
        template,
        expectedPackage(body),
      );
      let key: string | null | undefined;
      let fundingIdentity: "managed" | "personal";
      let credentialOwnerId: string | undefined;
      let credentialVersion: number;
      if (provider === "desktop") {
        const desktop = await desktopVideoCredentials(deps, deps.principal!, publicationId);
        if (!desktop.selected) {
          throw new ExecutionBlocked(desktop.selectionUnavailable
            ? "Desktop Video credential profile is unavailable. Repair or remove it before starting a new job."
            : "Desktop Video is unavailable until the deployment-managed key is configured.");
        }
        key = desktop.selected.key;
        fundingIdentity = desktop.selected.fundingIdentity;
        credentialOwnerId = desktop.selected.credentialOwnerId;
        credentialVersion = desktop.selected.credentialVersion;
      } else {
        const personal = await requiredFalRequestDeps(deps);
        key = personal.settings.integrations.falKey;
        if (!falVideoConfigured(key)) {
          throw new ExecutionBlocked(deps.principal!.role === "editor"
            ? "fal.ai is not enabled for this editor. Use Newsbee-managed Desktop Video or ask the newsroom owner for help."
            : "Add your personal fal.ai API key in Environment & API settings.");
        }
        fundingIdentity = "personal";
        credentialOwnerId = deps.principal!.id;
        credentialVersion = personal.credentialVersion;
      }
      const job: VideoJob = {
        ...newReleaseVideoJob(loaded.scope, content, template),
        provider,
        requested_by: deps.principal!.id,
        funding_identity: fundingIdentity,
        credential_owner_id: credentialOwnerId,
        credential_version: credentialVersion,
        ...(replacement ? { replacement_of: replacement._id } : {}),
      };
      await createPublicationVideoJob(deps.db, loaded.access.context, job, replacement?._id);
      let requestId: string;
      try {
        requestId = provider === "desktop"
          ? await submitDesktopVideo(job.prompt, job._id, key)
          : await submitFalVideo(job.prompt, key);
      } catch (error) {
        await updateJob(deps.db, job._id, loaded.scope, { status: "failed", error: safeError(error) });
        await recordReleaseVideoEvent(
          deps.db,
          loaded.scope,
          deps.principal!,
          job,
          "submitted",
          false,
          safeError(error),
        );
        throw error;
      }
      const updated = await updateJob(deps.db, job._id, loaded.scope, { request_id: requestId, status: "queued" });
      if (!updated) throw new Error("Submitted video job could not be reloaded.");
      await recordReleaseVideoEvent(deps.db, loaded.scope, deps.principal!, updated, "submitted");
      if (replacement) {
        await recordReleaseVideoEvent(deps.db, loaded.scope, deps.principal!, updated, "replaced");
      }
      const desktop = await availableDesktop(deps, deps.principal!, publicationId);
      return {
        ...publicManagement(await releaseVideoManagement(deps.db, loaded.scope, template), deps.principal!, desktop),
        video: publicVideo(updated, videoAccess(updated, deps.principal!, desktop)),
      };
    };
    if (body.action === "generate-content") {
      const managed = await managedRequestDeps(deps, deps.principal!, {
        runId: `release-video-package:${publicationId}:${releaseId}:${storyId}`,
        role: "release-video-package",
        publicationId,
      });
      await generateReleaseVideoPackage(deps.db, managed.discoveryModel, loaded.scope, template, expectedPackage(body));
      await appendPublicationChangeAudit(deps.db, {
        publication_id: publicationId,
        principal_id: deps.principal!.id,
        principal_email: deps.principal!.email,
        action: "video_package_prepared",
        resource_id: `${releaseId}:${storyId}`,
        detail: `Prepared release-scoped video package for story ${storyId} in immutable release ${releaseId}`,
        before_hash: null,
        after_hash: loaded.scope.releaseHash,
      });
      return publicManagement(
        await releaseVideoManagement(deps.db, loaded.scope, template),
        deps.principal!,
        await availableDesktop(deps, deps.principal!, publicationId),
      );
    }
    if (body.action === "save-package") {
      await saveReleaseVideoPackage(deps.db, loaded.scope, body.package, template, expectedPackage(body));
      return publicManagement(
        await releaseVideoManagement(deps.db, loaded.scope, template),
        deps.principal!,
        await availableDesktop(deps, deps.principal!, publicationId),
      );
    }
    if (body.action === "generate-video") {
      const provider = body.provider ?? "fal";
      if (provider !== "desktop" && provider !== "fal") throw new Error("Choose a valid video generation method.");
      return submitVideo(provider);
    }
    if (body.action === "replace-video") {
      if (!body.videoId) throw new Error("Choose the unavailable Desktop Video job to replace.");
      const current = await jobCollection(deps.db).findOne({
        _id: body.videoId,
        publication_id: publicationId,
        release_id: releaseId,
        story_id: storyId,
        provider: "desktop",
      });
      if (!current) throw new Error(`Unknown Desktop Video request: ${body.videoId}`);
      const desktop = await desktopVideoCredentials(deps, deps.principal!, publicationId);
      if (desktop.forJob(current)) {
        throw new Error("This Desktop Video job is still accessible and does not need replacement.");
      }
      if (current.requested_by !== deps.principal!.id) {
        throw new ExecutionBlocked("Only the account that submitted this Desktop Video job can replace it.");
      }
      return submitVideo("desktop", current);
    }
    if (body.action === "start-upload") {
      return startReleaseVideoUpload(deps.db, loaded.scope, deps.principal!.id, body.size ?? 0, loaded.access.context);
    }
    if (body.action === "finish-upload") {
      if (!body.uploadId) throw new Error("Invalid video upload");
      const management = await releaseVideoManagement(deps.db, loaded.scope, template);
      if (!management.package) throw new Error("Generate and save the release video package before uploading an MP4.");
      const video = await finishReleaseVideoUpload(
        deps.db,
        deps.store,
        loaded.scope,
        management.package,
        template,
        deps.principal!.id,
        body.uploadId,
        loaded.access.context,
      );
      await appendPublicationChangeAudit(deps.db, {
        publication_id: publicationId,
        principal_id: deps.principal!.id,
        principal_email: deps.principal!.email,
        action: "video_uploaded",
        resource_id: video._id,
        detail: `Uploaded an MP4 manually for immutable release ${releaseId} story ${storyId}`,
        before_hash: null,
        after_hash: loaded.scope.releaseHash,
      });
      return { video: publicVideo(video, videoAccess(video, deps.principal!, await availableDesktop(deps, deps.principal!, publicationId))) };
    }
    if (body.action === "refresh-video") {
      if (!body.videoId) throw new Error("Invalid video request ID");
      const current = await jobCollection(deps.db).findOne({
        _id: body.videoId,
        publication_id: publicationId,
        release_id: releaseId,
        story_id: storyId,
      });
      if (!current) throw new Error(`Unknown video request: ${body.videoId}`);
      if (current.status === "complete" || current.status === "failed"
        || (current.status === "uploading" && current.updated_at > Date.now() - 10 * 60_000)) {
        return { video: publicVideo(current, videoAccess(current, deps.principal!, await availableDesktop(deps, deps.principal!, publicationId))) };
      }
      if (current.requested_by && current.requested_by !== deps.principal!.id) {
        throw new ExecutionBlocked("The account that submitted this video must refresh its generation.");
      }
      if (!current.request_id) throw new Error("Video request has no provider job ID");
      if (current.provider === "desktop") {
        const desktop = await desktopVideoCredentials(deps, deps.principal!, publicationId);
        const credential = desktop.forJob(current);
        if (!credential) {
          return {
            video: publicVideo(current, {
              canRefresh: false,
              legacyUnavailable: true,
              canReplace: true,
            }),
          };
        }
        const result = await checkDesktopVideo(current.request_id, credential.key);
        const update: Partial<VideoJob> = { status: result.status };
        if (result.status === "failed") update.error = safeError(result.error);
        if (result.status === "complete") {
          update.drive_url = result.url;
          update.error = undefined;
        }
        const video = await updateJob(deps.db, current._id, loaded.scope, update);
        if (!video) throw new Error("Desktop Video job could not be reloaded.");
        await recordReleaseVideoEvent(deps.db, loaded.scope, deps.principal!, video, "polled", result.status !== "failed", result.status === "failed" ? safeError(result.error) : null);
        if (result.status === "complete") {
          await recordReleaseVideoEvent(deps.db, loaded.scope, deps.principal!, video, "completed");
        }
        return { video: publicVideo(video, videoAccess(video, deps.principal!, desktop)) };
      }
      const personal = await requiredFalRequestDeps(deps);
      const status = await falVideoStatus(current.request_id, personal.settings.integrations.falKey);
      if (status.status === "IN_QUEUE") {
        const video = await updateJob(deps.db, current._id, loaded.scope, { status: "queued" });
        if (video) await recordReleaseVideoEvent(deps.db, loaded.scope, deps.principal!, video, "polled");
        return { video: video && publicVideo(video, videoAccess(video, deps.principal!, await availableDesktop(deps, deps.principal!, publicationId))) };
      }
      if (status.status === "IN_PROGRESS") {
        const video = await updateJob(deps.db, current._id, loaded.scope, { status: "processing" });
        if (video) await recordReleaseVideoEvent(deps.db, loaded.scope, deps.principal!, video, "polled");
        return { video: video && publicVideo(video, videoAccess(video, deps.principal!, await availableDesktop(deps, deps.principal!, publicationId))) };
      }
      if (status.status === "FAILED") {
        const video = await updateJob(deps.db, current._id, loaded.scope, { status: "failed", error: status.error ?? "fal.ai video generation failed" });
        if (video) await recordReleaseVideoEvent(deps.db, loaded.scope, deps.principal!, video, "polled", false, status.error ?? "fal.ai video generation failed");
        return { video: video && publicVideo(video, videoAccess(video, deps.principal!, await availableDesktop(deps, deps.principal!, publicationId))) };
      }
      const claimed = await jobCollection(deps.db).updateOne({
        _id: current._id,
        publication_id: publicationId,
        release_id: releaseId,
        story_id: storyId,
        $or: [
          { status: { $in: ["queued", "processing", "upload_failed"] } },
          { status: "uploading", updated_at: { $lte: Date.now() - 10 * 60_000 } },
        ],
      }, { $set: { status: "uploading", updated_at: Date.now() }, $unset: { error: "" } });
      if (!claimed.modifiedCount) {
        const video = await jobCollection(deps.db).findOne({ _id: current._id });
        return {
          video: video && publicVideo(
            video,
            videoAccess(video, deps.principal!, await availableDesktop(deps, deps.principal!, publicationId)),
          ),
        };
      }
      try {
        const output = await falVideoResult(current.request_id, personal.settings.integrations.falKey);
        const folder = await runFolder(deps.store, "video-production", publicationId, releaseId, storyId);
        if (!deps.store.saveBinary) throw new Error("Video file uploads are not supported by the configured artifact store");
        const fileId = await deps.store.saveBinary(folder, `${current._id}.mp4`, output.content, output.mimeType);
        const video = await updateJob(deps.db, current._id, loaded.scope, {
            status: "complete",
            drive_file_id: fileId,
            drive_url: deps.store.kind === "drive" ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view` : undefined,
            error: undefined,
          });
        if (video) {
          await recordReleaseVideoEvent(deps.db, loaded.scope, deps.principal!, video, "polled");
          await recordReleaseVideoEvent(deps.db, loaded.scope, deps.principal!, video, "completed");
        }
        return {
          video: video && publicVideo(
            video,
            videoAccess(video, deps.principal!, await availableDesktop(deps, deps.principal!, publicationId)),
          ),
        };
      } catch (error) {
        const video = await updateJob(deps.db, current._id, loaded.scope, { status: "upload_failed", error: safeError(error) });
        if (video) await recordReleaseVideoEvent(deps.db, loaded.scope, deps.principal!, video, "polled", false, safeError(error));
        return {
          video: video && publicVideo(
            video,
            videoAccess(video, deps.principal!, await availableDesktop(deps, deps.principal!, publicationId)),
          ),
        };
      }
    }
    return Response.json({
      detail: "Choose generate-content, save-package, generate-video, replace-video, start-upload, finish-upload, or refresh-video.",
    }, { status: 422 });
  });
}
