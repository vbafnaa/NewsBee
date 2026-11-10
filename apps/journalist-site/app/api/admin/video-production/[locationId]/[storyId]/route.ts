import { adminRoute, jsonBody } from "@/lib/admin-api";
import { adminGuard, ownerGuard } from "@/lib/admin-session";
import { personalRequestDeps } from "@/pipeline/accounts/runtime";
import { runFolder } from "@/pipeline/storage/artifacts";
import { COLLECTIONS } from "@/pipeline/storage/mongo";
import { safeError } from "@/pipeline/core/redaction";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";
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
} from "@/pipeline/video-production";
import { falVideoResult, falVideoStatus, falVideoModel, falVideoConfigured, submitFalVideo } from "@/pipeline/connectors/fal-video";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ locationId: string; storyId: string }> };
type ActionBody = {
  action?: string;
  package?: unknown;
  videoId?: string;
  privacyStatus?: string;
  channelId?: string;
  playlistId?: string;
};

function jobCollection(db: import("mongodb").Db) {
  return db.collection<VideoJob>(COLLECTIONS.videoJobs);
}

async function updateJob(db: import("mongodb").Db, id: string, update: Partial<VideoJob>) {
  await jobCollection(db).updateOne({ _id: id }, { $set: { ...update, updated_at: Date.now() } });
  return jobCollection(db).findOne({ _id: id });
}

export async function GET(request: Request, context: Context) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  return adminRoute(request, async (deps) => {
    const { locationId, storyId } = await context.params;
    const personal = await personalRequestDeps(deps, deps.principal!, undefined, false, false);
    const story = await getVideoStory(deps.db, locationId, storyId);
    return {
      ...(await videoStoryManagement(deps.db, story)),
      falConfigured: falVideoConfigured(personal.settings.integrations.falKey),
      model: falVideoModel(),
      youtube: deps.principal!.role === "owner"
        ? await youtubeConnection(request, deps.principal!.email)
        : { connected: false, email: null },
      youtubeSettings: deps.principal!.role === "owner"
        ? await getYouTubeLocationSettings(deps.db, locationId, deps.principal!.id, deps.principal!.email)
        : null,
    };
  });
}

export async function POST(request: Request, context: Context) {
  const denied = await ownerGuard(request);
  if (denied) return denied;
  return adminRoute(request, async (deps) => {
    const { locationId, storyId } = await context.params;
    const body = await jsonBody<ActionBody>(request);
    const story = await getVideoStory(deps.db, locationId, storyId);

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
      const content = await generateVideoPackage(personal.discoveryModel, story);
      await saveVideoPackage(deps.db, story, content);
      return { ...(await videoStoryManagement(deps.db, story)), falConfigured: falVideoConfigured(personal.settings.integrations.falKey), model: falVideoModel() };
    }

    if (body.action === "save-package") {
      const content = await saveVideoPackage(deps.db, story, body.package);
      return { package: content };
    }

    if (body.action === "generate-video") {
      const personal = await personalRequestDeps(deps, deps.principal!, undefined, false, false);
      const falKey = personal.settings.integrations.falKey;
      if (!falVideoConfigured(falKey)) throw new ExecutionBlocked("Add your personal fal.ai API key in Environment & API settings.");
      const content = await saveVideoPackage(deps.db, story, body.package);
      const job = newVideoJob(story, content.videoPrompt);
      await jobCollection(deps.db).insertOne(job);
      try {
        const requestId = await submitFalVideo(job.prompt, falKey);
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
          ? await saveVideoPackage(deps.db, story, body.package)
          : (await videoStoryManagement(deps.db, story)).package;
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
      if (!current.request_id) throw new Error("Video request has no fal.ai request ID");

      const personal = await personalRequestDeps(deps, deps.principal!, undefined, false, false);
      const falKey = personal.settings.integrations.falKey;
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
