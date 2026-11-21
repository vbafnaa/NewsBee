import { adminRoute, jsonBody } from "@/lib/admin-api";
import { personalRequestDeps } from "@/pipeline/accounts/runtime";
import { runFolder } from "@/pipeline/storage/artifacts";
import { COLLECTIONS } from "@/pipeline/storage/mongo";
import { safeError } from "@/pipeline/core/redaction";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";
import { getOutputChannel } from "@/pipeline/orchestration/output-channels";
import {
  addYouTubeVideoToPlaylist,
  listYouTubeChannels,
  listYouTubePlaylists,
  publishVideoToYouTube,
  youtubeConnection,
  youtubePrivacyStatus,
} from "@/pipeline/connectors/youtube";
import { getYouTubeLocationSettings, saveYouTubeLocationSettings } from "@/pipeline/youtube-location-settings";
import {
  generateVideoPackage,
  getVideoStory,
  newVideoJob,
  saveVideoPackage,
  videoStoryManagement,
  type VideoJob,
  type VideoProvider,
} from "@/pipeline/video-production";
import { falVideoResult, falVideoStatus, falVideoModel, falVideoConfigured, submitFalVideo } from "@/pipeline/connectors/fal-video";
import { checkDesktopVideo, submitDesktopVideo } from "@/pipeline/connectors/desktop-video";
import { finishVideoUpload, saveVideoChunk, startVideoUpload, VIDEO_UPLOAD_CHUNK_BYTES } from "@/pipeline/video-upload";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ locationId: string; storyId: string }> };
type ActionBody = {
  action?: string;
  package?: unknown;
  provider?: VideoProvider;
  videoId?: string;
  privacyStatus?: string;
  channelId?: string;
  playlistId?: string;
  uploadId?: string;
  size?: number;
};

function jobCollection(db: import("mongodb").Db) {
  return db.collection<VideoJob>(COLLECTIONS.videoJobs);
}

function canRefreshVideo(video: VideoJob, principal: { id: string; role: string }) {
  return video.requested_by ? video.requested_by === principal.id : principal.role === "owner";
}

async function updateJob(db: import("mongodb").Db, id: string, update: Partial<VideoJob>) {
  await jobCollection(db).updateOne({ _id: id }, { $set: { ...update, updated_at: Date.now() } });
  return jobCollection(db).findOne({ _id: id });
}

export async function GET(request: Request, context: Context) {
  let stage = "initialize_admin_request";
  let storyParams: Awaited<Context["params"]> | undefined;
  return adminRoute(request, async (deps) => {
    stage = "resolve_story_parameters";
    storyParams = await context.params;
    const { locationId, storyId } = storyParams;
    const principal = deps.principal!;
    const query = new URL(request.url).searchParams;
    const channelId = query.get("channel") ?? undefined;
    if (channelId !== undefined) {
      const channel = await getOutputChannel(deps.db, principal.id, channelId);
      if (!channel?.selectedLocationIds.includes(locationId)) {
        return Response.json({ detail: "Story is unavailable in this publishing channel." }, { status: 404 });
      }
    }
    const downloadId = query.get("download");
    if (downloadId !== null) {
      stage = "download_video";
      await getVideoStory(deps.db, locationId, storyId);
      const video = await jobCollection(deps.db).findOne({
        _id: downloadId, location_id: locationId, story_id: storyId, status: "complete",
      });
      if (!video?.drive_file_id) throw new Error("Unknown video request or video is not ready to download");
      if (!deps.store.readBinary) throw new Error("Video storage does not support downloads");
      const bytes = await deps.store.readBinary(video.drive_file_id);
      return new Response(new Blob([Uint8Array.from(bytes)]).stream(), { headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": 'attachment; filename="story-video.mp4"',
        "X-Content-Type-Options": "nosniff",
      } });
    }

    stage = "load_personal_settings";
    const personal = await personalRequestDeps(deps, principal, undefined, false, false).catch((error: unknown) => {
      if (error instanceof ExecutionBlocked) return null;
      throw error;
    });
    stage = "load_published_story";
    const story = await getVideoStory(deps.db, locationId, storyId);
    stage = "load_video_package_and_jobs";
    const management = await videoStoryManagement(deps.db, story, channelId);
    stage = "load_video_provider_settings";
    const falConfigured = personal !== null && falVideoConfigured(personal.settings.integrations.falKey);
    const model = falVideoModel();
    stage = "load_youtube_connection";
    const youtube = principal.role === "owner"
      ? await youtubeConnection(request, principal.email)
      : { connected: false, email: null };
    stage = "load_youtube_location_settings";
    const youtubeSettings = principal.role === "owner"
      ? await getYouTubeLocationSettings(deps.db, locationId, principal.id, principal.email)
      : null;
    stage = "serialize_video_production_response";
    return {
      ...management,
      videos: management.videos.map((video) => ({ ...video, canRefresh: canRefreshVideo(video, principal) })),
      falConfigured,
      desktopConfigured: Boolean(personal?.settings.integrations.desktopVideoKey),
      model,
      youtube,
      youtubeSettings,
    };
  }, () => ({ stage, ...storyParams }));
}

export async function POST(request: Request, context: Context) {
  return adminRoute(request, async (deps) => {
    const { locationId, storyId } = await context.params;
    const query = new URL(request.url).searchParams;
    const channelId = query.get("channel") ?? undefined;
    const channel = channelId === undefined ? null : await getOutputChannel(deps.db, deps.principal!.id, channelId);
    if (channelId !== undefined && !channel?.selectedLocationIds.includes(locationId)) {
      return Response.json({ detail: "Story is unavailable in this publishing channel." }, { status: 404 });
    }
    const story = await getVideoStory(deps.db, locationId, storyId);
    if (query.get("action") === "upload-chunk") {
      const uploadId = query.get("uploadId");
      const index = Number(query.get("index"));
      if (!uploadId || !Number.isSafeInteger(index) || index < 0 || request.headers.get("content-type") !== "application/octet-stream" ||
          Number(request.headers.get("content-length")) > VIDEO_UPLOAD_CHUNK_BYTES) {
        throw new Error("Invalid video upload chunk");
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      await saveVideoChunk(deps.db, story, deps.principal!.id, uploadId, index, bytes);
      return { uploaded: true };
    }
    const body = await jsonBody<ActionBody>(request);
    if (["list-youtube-channels", "list-youtube-playlists", "save-youtube-location-settings", "publish-youtube"].includes(body.action ?? "")
      && deps.principal!.role !== "owner") {
      throw new ExecutionBlocked("Owner access required to manage YouTube.");
    }

    if (body.action === "start-upload") {
      return startVideoUpload(deps.db, story, deps.principal!.id, body.size ?? 0);
    }

    if (body.action === "finish-upload") {
      if (!body.uploadId) throw new Error("Invalid video upload");
      return { video: await finishVideoUpload(deps.db, deps.store, story, deps.principal!.id, body.uploadId) };
    }

    if (body.action === "list-youtube-channels") {
      return { youtubeChannels: await listYouTubeChannels(request, deps.principal!.email) };
    }

    if (body.action === "list-youtube-playlists") {
      if (!body.channelId) throw new Error("Choose a YouTube channel first");
      return { youtubePlaylists: await listYouTubePlaylists(request, deps.principal!.email, body.channelId) };
    }

    if (body.action === "save-youtube-location-settings") {
      if (!body.channelId) throw new Error("Choose a YouTube channel");
      const channels = await listYouTubeChannels(request, deps.principal!.email);
      const channel = channels.find((item) => item.id === body.channelId);
      if (!channel) throw new Error("Choose a channel available to the signed-in YouTube account");

      let playlist: { id: string; title: string } | null = null;
      if (body.playlistId) {
        const playlists = await listYouTubePlaylists(request, deps.principal!.email, channel.id);
        playlist = playlists.find((item) => item.id === body.playlistId) ?? null;
        if (!playlist) throw new Error("Choose a playlist belonging to the selected channel");
      }

      return {
        youtubeSettings: await saveYouTubeLocationSettings(
          deps.db, locationId, deps.principal!.id, deps.principal!.email, channel, playlist,
        ),
      };
    }

    if (body.action === "generate-content") {
      const personal = await personalRequestDeps(deps, deps.principal!, undefined, false, true);
      const content = await generateVideoPackage(personal.discoveryModel, story, channel?.videoPromptTemplate);
      await saveVideoPackage(deps.db, story, content, content.generationPrompt, channelId);
      return { ...(await videoStoryManagement(deps.db, story, channelId)), falConfigured: falVideoConfigured(personal.settings.integrations.falKey), model: falVideoModel() };
    }

    if (body.action === "save-package") {
      const content = await saveVideoPackage(deps.db, story, body.package, undefined, channelId);
      return { package: content };
    }

    if (body.action === "generate-video") {
      const personal = await personalRequestDeps(deps, deps.principal!, undefined, false, false);
      const { falKey, desktopVideoKey } = personal.settings.integrations;
      const provider = body.provider === undefined ? "fal" : body.provider;
      if (provider !== "fal" && provider !== "desktop") throw new Error("Choose a valid video generation method.");
      if (provider === "fal" && !falVideoConfigured(falKey)) {
        throw new ExecutionBlocked("Add your personal fal.ai API key in Environment & API settings.");
      }
      if (provider === "desktop" && !desktopVideoKey) {
        throw new ExecutionBlocked("Add a Desktop Video API key in Environment & API settings.");
      }
      const content = await saveVideoPackage(deps.db, story, body.package, undefined, channelId);
      const job = { ...newVideoJob(story, content.videoPrompt), provider, requested_by: deps.principal!.id };
      await jobCollection(deps.db).insertOne(job);
      try {
        const requestId = provider === "desktop"
          ? await submitDesktopVideo(job.prompt, job._id, desktopVideoKey)
          : await submitFalVideo(job.prompt, falKey);
        const updated = await updateJob(deps.db, job._id, { request_id: requestId, status: "queued" });
        return { video: updated };
      } catch (error) {
        await updateJob(deps.db, job._id, { status: "failed", error: safeError(error) });
        throw error;
      }
    }

    if (body.action === "publish-youtube") {
      if (!body.videoId) throw new Error("Choose a generated video to upload");
      const privacyStatus = youtubePrivacyStatus(body.privacyStatus);
      if (!privacyStatus) throw new Error("Choose a valid YouTube visibility setting");
      const youtubeSettings = await getYouTubeLocationSettings(deps.db, locationId, deps.principal!.id, deps.principal!.email);
      if (!youtubeSettings) throw new Error("Select and save a YouTube channel for this location first");

      const collection = jobCollection(deps.db);
      const current = await collection.findOne({ _id: body.videoId, location_id: locationId, story_id: storyId });
      if (!current) throw new Error(`Unknown video request: ${body.videoId}`);
      if (current.youtube_upload_status === "published" && current.youtube_url) return { video: current };
      if (current.youtube_upload_status === "playlist_failed" && current.youtube_video_id) {
        if (current.youtube_channel_id !== youtubeSettings.channel_id) {
          throw new Error("This video was uploaded to a different YouTube channel. Select that channel to retry its playlist.");
        }
        if (!youtubeSettings.playlist_id) {
          return {
            video: await updateJob(deps.db, current._id, {
              youtube_upload_status: "published",
              youtube_playlist_id: "",
              youtube_playlist_title: "",
              youtube_error: "",
            }),
          };
        }
        await addYouTubeVideoToPlaylist(request, deps.principal!.email, youtubeSettings.playlist_id, current.youtube_video_id);
        return {
          video: await updateJob(deps.db, current._id, {
            youtube_upload_status: "published",
            youtube_playlist_id: youtubeSettings.playlist_id,
            youtube_playlist_title: youtubeSettings.playlist_title ?? "",
            youtube_error: "",
          }),
        };
      }
      if (current.status !== "complete" || !current.drive_file_id) {
        throw new Error("Only a completed video stored in Google Drive can be uploaded to YouTube");
      }

      const claimed = await collection.updateOne({
        _id: current._id,
        status: "complete",
        youtube_video_id: { $exists: false },
        $or: [{ youtube_upload_status: { $exists: false } }, { youtube_upload_status: "failed" }],
      }, { $set: { youtube_upload_status: "uploading", youtube_error: "" } });
      if (!claimed.modifiedCount) {
        const latest = await collection.findOne({ _id: current._id });
        if (latest?.youtube_upload_status === "published") return { video: latest };
        throw new Error("A YouTube upload is already in progress for this video");
      }

      try {
        const content = body.package
          ? await saveVideoPackage(deps.db, story, body.package, undefined, channelId)
          : (await videoStoryManagement(deps.db, story, channelId)).package;
        if (!content) throw new Error("Generate and save the YouTube title and description before uploading");
        if (!deps.store.readBinary) throw new Error("The configured artifact store cannot read video files");
        const bytes = await deps.store.readBinary(current.drive_file_id);
        const published = await publishVideoToYouTube(request, deps.principal!.email, bytes, {
          title: content.youtubeTitle,
          description: content.youtubeDescription,
          tags: content.youtubeTags,
        }, privacyStatus);
        const video = await updateJob(deps.db, current._id, {
          youtube_upload_status: youtubeSettings.playlist_id ? "playlist_failed" : "published",
          youtube_video_id: published.videoId,
          youtube_url: published.url,
          youtube_channel_id: published.channelId ?? youtubeSettings.channel_id,
          youtube_channel_title: youtubeSettings.channel_title,
          youtube_playlist_id: youtubeSettings.playlist_id ?? undefined,
          youtube_playlist_title: youtubeSettings.playlist_title ?? undefined,
          youtube_privacy_status: privacyStatus,
          youtube_published_at: Date.now(),
          youtube_error: "",
        });
        if (published.channelId && published.channelId !== youtubeSettings.channel_id) {
          const warning = `Video was uploaded to YouTube channel ${published.channelId}, not the selected channel ${youtubeSettings.channel_id}. Reconnect YouTube while signed into the intended channel.`;
          const updated = await updateJob(deps.db, current._id, { youtube_error: warning });
          return { video: updated, warning };
        }
        if (youtubeSettings.playlist_id) {
          await addYouTubeVideoToPlaylist(request, deps.principal!.email, youtubeSettings.playlist_id, published.videoId);
          await updateJob(deps.db, current._id, { youtube_upload_status: "published", youtube_error: "" });
        }
        return { video: await collection.findOne({ _id: current._id }) ?? video };
      } catch (error) {
        const latest = await collection.findOne({ _id: current._id });
        await updateJob(deps.db, current._id, {
          youtube_upload_status: latest?.youtube_video_id ? "playlist_failed" : "failed",
          youtube_error: safeError(error),
        });
        throw error;
      }
    }

    if (body.action === "refresh-video") {
      if (!body.videoId) throw new Error("Invalid video request ID");
      const collection = jobCollection(deps.db);
      const current = await collection.findOne({ _id: body.videoId, location_id: locationId, story_id: storyId });
      if (!current) throw new Error(`Unknown video request: ${body.videoId}`);
      if (current.status === "complete" || current.status === "failed" ||
          (current.status === "uploading" && current.updated_at > Date.now() - 10 * 60_000)) return { video: current };
      if (!canRefreshVideo(current, deps.principal!)) {
        throw new ExecutionBlocked("The account that submitted this video must refresh its generation.");
      }
      if (!current.request_id) throw new Error("Video request has no provider job ID");

      const personal = await personalRequestDeps(deps, deps.principal!, undefined, false, false);
      const { falKey, desktopVideoKey } = personal.settings.integrations;
      if (current.provider === "desktop") {
        const result = await checkDesktopVideo(current.request_id, desktopVideoKey);
        const update: Partial<VideoJob> = { status: result.status };
        if (result.status === "failed") update.error = safeError(result.error);
        if (result.status === "complete") update.drive_url = result.url;
        await collection.updateOne(
          { _id: current._id, status: { $in: result.status === "queued" ? ["queued"] : ["queued", "processing"] } },
          { $set: { ...update, updated_at: Date.now() } },
        );
        return { video: await collection.findOne({ _id: current._id }) };
      }
      const status = await falVideoStatus(current.request_id, falKey);
      if (status.status === "IN_QUEUE") {
        return { video: await updateJob(deps.db, current._id, { status: "queued" }) };
      }
      if (status.status === "IN_PROGRESS") {
        return { video: await updateJob(deps.db, current._id, { status: "processing" }) };
      }
      if (status.status === "FAILED") {
        return { video: await updateJob(deps.db, current._id, { status: "failed", error: status.error ?? "fal.ai video generation failed" }) };
      }

      const claimed = await collection.updateOne(
        { _id: current._id, $or: [
          { status: { $in: ["queued", "processing", "upload_failed"] } },
          { status: "uploading", updated_at: { $lte: Date.now() - 10 * 60_000 } },
        ] },
        { $set: { status: "uploading", updated_at: Date.now() }, $unset: { error: "" } },
      );
      if (!claimed.modifiedCount) return { video: await collection.findOne({ _id: current._id }) };
      try {
        const output = await falVideoResult(current.request_id, falKey);
        const folder = await runFolder(deps.store, "video-production", locationId, storyId);
        if (!deps.store.saveBinary) throw new Error("Video file uploads are not supported by the configured artifact store");
        const fileId = await deps.store.saveBinary(folder, `${current._id}.mp4`, output.content, output.mimeType);
        const video = await updateJob(deps.db, current._id, {
          status: "complete",
          drive_file_id: fileId,
          drive_url: deps.store.kind === "drive" ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view` : undefined,
          error: undefined,
        });
        return { video };
      } catch (error) {
        const video = await updateJob(deps.db, current._id, { status: "upload_failed", error: safeError(error) });
        return { video };
      }
    }

    throw new Error("Invalid video production action");
  });
}
