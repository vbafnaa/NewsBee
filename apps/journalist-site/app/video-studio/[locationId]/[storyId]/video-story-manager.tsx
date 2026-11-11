"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";

type ContentPackage = {
  youtubeTitle: string;
  youtubeDescription: string;
  youtubeTags: string[];
  tiktokCaption: string;
  spokenScript: string;
  videoPrompt: string;
  subtitlesSrt: string;
};
type Story = {
  locationId: string;
  locationName: string;
  storyId: string;
  editionId: string;
  title: string;
  summary: string;
  whenWhere: string;
  eventDate: string;
  sourceUrl: string | null;
};
type Video = {
  _id: string;
  status: string;
  prompt: string;
  source?: "upload";
  created_at: number;
  error?: string;
  drive_url?: string;
  drive_file_id?: string;
  youtube_upload_status?: string;
  youtube_url?: string;
  youtube_channel_id?: string;
  youtube_channel_title?: string;
  youtube_playlist_title?: string;
  youtube_privacy_status?: string;
  youtube_error?: string;
};
type Data = {
  detail?: string;
  story?: Story;
  package?: ContentPackage | null;
  packagePrompt?: string;
  packagePromptReconstructed?: boolean;
  uploadId?: string;
  videos?: Video[];
  video?: Video;
  falConfigured?: boolean;
  model?: string;
  youtube?: { connected: boolean; email: string | null };
  youtubeChannels?: YouTubeChannel[];
  youtubePlaylists?: YouTubePlaylist[];
  youtubeSettings?: YouTubeLocationSettings | null;
  warning?: string;
};
type EditablePackage = ContentPackage & { tagsText: string };
type PrivacyStatus = "private" | "unlisted" | "public";
type YouTubeChannel = { id: string; title: string };
type YouTubePlaylist = { id: string; title: string };
type YouTubeLocationSettings = {
  channel_id: string;
  channel_title: string;
  playlist_id: string | null;
  playlist_title: string | null;
};
const emptyPackage: EditablePackage = {
  youtubeTitle: "", youtubeDescription: "", youtubeTags: [], tiktokCaption: "", spokenScript: "", videoPrompt: "", subtitlesSrt: "", tagsText: "",
};
const activeStatuses = new Set(["submitting", "queued", "processing", "uploading"]);
const uploadChunkBytes = 2 * 1024 * 1024;
const maxUploadBytes = 100 * 1024 * 1024;

export default function VideoStoryManager({ locationId, storyId, accountEmail, owner, backHref }: {
  locationId: string; storyId: string; accountEmail: string; owner: boolean; backHref: string;
}) {
  const [story, setStory] = useState<Story | null>(null);
  const [content, setContent] = useState<EditablePackage>(emptyPackage);
  const [videos, setVideos] = useState<Video[]>([]);
  const [packagePrompt, setPackagePrompt] = useState("");
  const [packagePromptReconstructed, setPackagePromptReconstructed] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [falConfigured, setFalConfigured] = useState(false);
  const [model, setModel] = useState("");
  const [youtube, setYoutube] = useState<Data["youtube"]>({ connected: false, email: null });
  const [youtubeSettings, setYoutubeSettings] = useState<YouTubeLocationSettings | null>(null);
  const [youtubeChannels, setYoutubeChannels] = useState<YouTubeChannel[]>([]);
  const [youtubePlaylists, setYoutubePlaylists] = useState<YouTubePlaylist[]>([]);
  const [youtubeChannelId, setYoutubeChannelId] = useState("");
  const [youtubePlaylistId, setYoutubePlaylistId] = useState("");
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  const [privacyStatus, setPrivacyStatus] = useState<PrivacyStatus>("private");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`);
    const data = await response.json() as Data;
    if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
    setStory(data.story ?? null);
    setVideos(data.videos ?? []);
    setPackagePrompt(data.packagePrompt ?? "");
    setPackagePromptReconstructed(Boolean(data.packagePromptReconstructed));
    setFalConfigured(Boolean(data.falConfigured));
    setModel(data.model ?? "");
    setYoutube(data.youtube ?? { connected: false, email: null });
    setYoutubeSettings(data.youtubeSettings ?? null);
    setContent(data.package
      ? { ...data.package, tagsText: data.package.youtubeTags.join(", ") }
      : emptyPackage);
  }, [locationId, storyId]);

  useEffect(() => {
    if (!owner) return;
    if (!youtube?.connected) return;
    let cancelled = false;
    async function loadChannels() {
      setYoutubeLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "list-youtube-channels" }),
        });
        const data = await response.json() as Data;
        if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
        if (cancelled) return;
        const channels = data.youtubeChannels ?? [];
        setYoutubeChannels(channels);
        const selected = channels.find((channel) => channel.id === youtubeSettings?.channel_id) ?? channels[0];
        setYoutubeChannelId(selected?.id ?? "");
        if (!selected) {
          setYoutubePlaylists([]);
          setYoutubePlaylistId("");
          return;
        }
        if (youtubeSettings?.channel_id !== selected.id) {
          const saveResponse = await fetch(`/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "save-youtube-location-settings", channelId: selected.id, playlistId: "" }),
          });
          const savedData = await saveResponse.json() as Data;
          if (!saveResponse.ok) throw new Error(savedData.detail ?? `Request failed (${saveResponse.status})`);
          if (!cancelled) setYoutubeSettings(savedData.youtubeSettings ?? null);
        }
        const playlistResponse = await fetch(`/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "list-youtube-playlists", channelId: selected.id }),
        });
        const playlistData = await playlistResponse.json() as Data;
        if (!playlistResponse.ok) throw new Error(playlistData.detail ?? `Request failed (${playlistResponse.status})`);
        if (cancelled) return;
        const playlists = playlistData.youtubePlaylists ?? [];
        setYoutubePlaylists(playlists);
        const preferred = playlists.find((playlist) => playlist.id === youtubeSettings?.playlist_id);
        setYoutubePlaylistId(preferred?.id ?? "");
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setYoutubeLoading(false);
      }
    }
    void loadChannels();
    return () => { cancelled = true; };
  }, [locationId, owner, storyId, youtube?.connected, youtubeSettings?.channel_id, youtubeSettings?.playlist_id]);

  useEffect(() => {
    void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [load]);

  const pendingIds = useMemo(() => videos.filter((video) => activeStatuses.has(video.status)).map((video) => video._id).join(","), [videos]);
  useEffect(() => {
    if (!owner || !pendingIds) return;
    const timer = window.setInterval(async () => {
      try {
        const responses = await Promise.all(pendingIds.split(",").map((videoId) => fetch(
          `/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "refresh-video", videoId }) },
        )));
        const failed = responses.find((response) => !response.ok);
        if (failed) {
          const data = await failed.json() as Data;
          throw new Error(data.detail ?? `Request failed (${failed.status})`);
        }
        const response = await fetch(`/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`);
        const data = await response.json() as Data;
        if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
        setVideos(data.videos ?? []);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }, 6000);
    return () => window.clearInterval(timer);
  }, [load, locationId, owner, pendingIds, storyId]);

  function toPayload() {
    return {
      youtubeTitle: content.youtubeTitle,
      youtubeDescription: content.youtubeDescription,
      youtubeTags: content.tagsText.split(",").map((tag) => tag.trim()).filter(Boolean),
      tiktokCaption: content.tiktokCaption,
      spokenScript: content.spokenScript,
      videoPrompt: content.videoPrompt,
      subtitlesSrt: content.subtitlesSrt,
    };
  }

  async function post(action: string, packageBody?: unknown, extra?: Record<string, unknown>) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(packageBody ? { package: packageBody } : {}), ...extra }),
      });
      const data = await response.json() as Data;
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      if (data.package) setContent({ ...data.package, tagsText: data.package.youtubeTags.join(", ") });
      if (data.packagePrompt) setPackagePrompt(data.packagePrompt);
      if (data.packagePromptReconstructed !== undefined) setPackagePromptReconstructed(data.packagePromptReconstructed);
      if (data.story) setStory(data.story);
      if (data.videos) setVideos(data.videos);
      if (data.video) setVideos((current) => current.map((video) => video._id === data.video!._id ? data.video! : video));
      if (data.youtubeSettings) setYoutubeSettings(data.youtubeSettings);
      if (action === "generate-content") setNotice("Content package created. Review and edit every field before requesting a video.");
      else if (action === "save-package") setNotice("Video package saved.");
      else if (action === "generate-video") {
        setNotice("Video request submitted to fal.ai.");
        await load();
      } else if (action === "publish-youtube") {
        setNotice(data.warning ?? `Uploaded to YouTube as ${privacyStatus}${youtubeSettings?.playlist_title ? ` and added to ${youtubeSettings.playlist_title}` : ""}.`);
      }
      if (action === "generate-content") await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      if (action === "publish-youtube") await load();
    } finally {
      setBusy("");
    }
  }

  async function saveLocationYoutubeSettings(channelId: string, playlistId: string) {
    setBusy("youtube-settings");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save-youtube-location-settings", channelId, playlistId }),
      });
      const data = await response.json() as Data;
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      setYoutubeSettings(data.youtubeSettings ?? null);
      const selectedPlaylist = youtubePlaylists.find((playlist) => playlist.id === playlistId);
      const selectedChannel = youtubeChannels.find((channel) => channel.id === channelId);
      setNotice(`Saved ${selectedChannel?.title ?? "YouTube channel"}${selectedPlaylist ? ` and playlist ${selectedPlaylist.title}` : " with no playlist"} for this location.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setYoutubeChannelId(youtubeSettings?.channel_id ?? "");
      setYoutubePlaylistId(youtubeSettings?.playlist_id ?? "");
    } finally {
      setBusy("");
    }
  }

  async function changeYouTubeChannel(channelId: string) {
    setYoutubeChannelId(channelId);
    setYoutubePlaylistId("");
    setYoutubePlaylists([]);
    if (!channelId) return;
    setYoutubeLoading(true);
    try {
      const response = await fetch(`/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list-youtube-playlists", channelId }),
      });
      const data = await response.json() as Data;
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      setYoutubePlaylists(data.youtubePlaylists ?? []);
      await saveLocationYoutubeSettings(channelId, "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setYoutubeLoading(false);
    }
  }

  async function refreshVideo(videoId: string) {
    setBusy("refresh-video");
    setError("");
    try {
      const response = await fetch(`/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-video", videoId }),
      });
      const data = await response.json() as Data;
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      if (data.video) setVideos((current) => current.map((video) => video._id === data.video!._id ? data.video! : video));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function uploadVideo() {
    if (!uploadFile) return;
    setBusy("upload-video");
    setError("");
    setNotice("");
    setUploadProgress(0);
    const endpoint = `/api/admin/video-production/${encodeURIComponent(locationId)}/${encodeURIComponent(storyId)}`;
    try {
      if (!uploadFile.name.toLowerCase().endsWith(".mp4") || uploadFile.type !== "video/mp4" ||
          !uploadFile.size || uploadFile.size > maxUploadBytes) {
        throw new Error("Choose an MP4 video no larger than 100 MB.");
      }
      const start = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start-upload", size: uploadFile.size }),
      });
      const started = await start.json() as Data;
      if (!start.ok || !started.uploadId) throw new Error(started.detail ?? "Could not start video upload");
      const count = Math.ceil(uploadFile.size / uploadChunkBytes);
      for (let index = 0; index < count; index += 1) {
        const response = await fetch(`${endpoint}?action=upload-chunk&uploadId=${encodeURIComponent(started.uploadId)}&index=${index}`, {
          method: "POST", headers: { "Content-Type": "application/octet-stream" },
          body: uploadFile.slice(index * uploadChunkBytes, (index + 1) * uploadChunkBytes),
        });
        if (!response.ok) {
          const result = await response.json() as Data;
          throw new Error(result.detail ?? `Upload failed (${response.status})`);
        }
        setUploadProgress(Math.round((index + 1) / count * 100));
      }
      const finish = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finish-upload", uploadId: started.uploadId }),
      });
      const finished = await finish.json() as Data;
      if (!finish.ok) throw new Error(finished.detail ?? `Could not save video (${finish.status})`);
      setUploadFile(null);
      setNotice("Video saved to this story. You can publish it to YouTube after saving a video package.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  if (!story && !error) return <p role="status">Loading story…</p>;
  return (
    <section className="workspace-panel">
      <p><Link href={backHref}>← Back to channel workspace</Link></p>
      {story && <>
        <h2>{story.title}</h2>
        <p>{story.summary}</p>
        <dl>
          <dt>Location</dt><dd>{story.locationName}</dd>
          <dt>Story date</dt><dd>{story.eventDate || "Not listed"}</dd>
          <dt>Original source</dt><dd>{story.sourceUrl ? <a href={story.sourceUrl} target="_blank" rel="noreferrer">{story.sourceUrl}</a> : "Not listed"}</dd>
        </dl>
        <p>Model: <strong>{model}</strong> · 15 seconds · 9:16 portrait · native audio generation.</p>
        {!falConfigured && <p role="alert">Add a fal.ai key in Environment &amp; API settings to enable video generation. Only the configured owner may use the server&apos;s <code>FAL_KEY</code>.</p>}
        {owner && <div className="button-row">
          {youtube?.connected
            ? <p role="status">YouTube connected as <strong>{youtube.email}</strong>.</p>
            : <>
              <p>Connect the Google account currently signed in to upload videos to its YouTube channel.</p>
              <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void signIn("google", { redirectTo: window.location.href }, {
                scope: "openid email profile https://www.googleapis.com/auth/youtube",
                access_type: "offline",
                include_granted_scopes: "true",
                prompt: "select_account consent",
                login_hint: accountEmail,
              })}>Connect YouTube</button>
            </>}
        </div>}
        {owner && youtube?.connected && <label>
          YouTube channel
          <select value={youtubeChannelId} disabled={youtubeLoading || Boolean(busy)} onChange={(event) => void changeYouTubeChannel(event.target.value)}>
            <option value="">Choose a channel</option>
            {youtubeChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.title}</option>)}
          </select>
        </label>}
        {owner && youtube?.connected && youtubeChannelId && <label>
          Location playlist
          <select value={youtubePlaylistId} disabled={youtubeLoading || Boolean(busy)} onChange={(event) => {
            const playlistId = event.target.value;
            setYoutubePlaylistId(playlistId);
            void saveLocationYoutubeSettings(youtubeChannelId, playlistId);
          }}>
            <option value="">Do not add to a playlist</option>
            {youtubePlaylists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.title}</option>)}
          </select>
          <small>The selected playlist is saved for {story?.locationName}.</small>
        </label>}
        {owner && youtube?.connected && <label>
          YouTube visibility
          <select value={privacyStatus} onChange={(event) => setPrivacyStatus(event.target.value as PrivacyStatus)}>
            <option value="private">Private — review before release</option>
            <option value="unlisted">Unlisted — anyone with the link</option>
            <option value="public">Public — publish immediately</option>
          </select>
        </label>}
        {owner && <div className="button-row">
          <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void post("generate-content")}>
            {busy === "generate-content" ? "Generating package…" : "Generate the video package"}
          </button>
          <button type="button" className="secondary" disabled={Boolean(busy) || !content.youtubeTitle} onClick={() => void post("save-package", toPayload())}>
            {busy === "save-package" ? "Saving…" : "Save edits"}
          </button>
        </div>}
        {!owner && !content.youtubeTitle && <p>No video package has been created for this story yet.</p>}
        {packagePrompt && <details><summary>Full AI prompt for title, description and script</summary>
          {packagePromptReconstructed && <p>Original prompt was not saved for this older package; this is reconstructed from the current story.</p>}
          <pre className="artifact-preview">{packagePrompt}</pre>
        </details>}
        {content.youtubeTitle && <>
          <div className="form-grid">
            <label>YouTube title<input maxLength={100} value={content.youtubeTitle} readOnly={!owner} onChange={(event) => setContent({ ...content, youtubeTitle: event.target.value })} /></label>
            <label>YouTube tags<input value={content.tagsText} readOnly={!owner} onChange={(event) => setContent({ ...content, tagsText: event.target.value })} /></label>
            <label className="full-width">YouTube description<textarea rows={8} maxLength={5000} value={content.youtubeDescription} readOnly={!owner} onChange={(event) => setContent({ ...content, youtubeDescription: event.target.value })} /></label>
            <label className="full-width">TikTok caption<textarea rows={4} value={content.tiktokCaption} readOnly={!owner} onChange={(event) => setContent({ ...content, tiktokCaption: event.target.value })} /></label>
            <label className="full-width">Exact spoken dialogue<textarea rows={4} value={content.spokenScript} readOnly={!owner} onChange={(event) => setContent({ ...content, spokenScript: event.target.value })} /></label>
            <label className="full-width">fal.ai generation prompt<textarea rows={14} value={content.videoPrompt} readOnly={!owner} onChange={(event) => setContent({ ...content, videoPrompt: event.target.value })} /></label>
            <label className="full-width">English SRT draft<textarea rows={10} value={content.subtitlesSrt} readOnly={!owner} onChange={(event) => setContent({ ...content, subtitlesSrt: event.target.value })} /></label>
          </div>
          <p role="note">Subtitle timing is estimated from the script, not transcribed from generated audio. Review the rendered video, correct the dialogue and SRT, and update any time-sensitive facts before publishing.</p>
          {owner && <label className="checkbox-label">
            <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />
            I reviewed the facts and prompt, and will check the rendered speech and captions before posting.
          </label>}
        </>}
        {owner && <div className="button-row">
          <button type="button" disabled={Boolean(busy) || !content.youtubeTitle || !falConfigured || !reviewed} onClick={() => void post("generate-video", toPayload())}>
            {busy === "generate-video" ? "Submitting…" : "Generate video with fal.ai"}
          </button>
          {!content.youtubeTitle && <small>Generate the video package first to enable fal.ai generation.</small>}
        </div>}
        {owner && <div>
          <label>Upload an MP4 video to this story (up to 100 MB)
            <input type="file" accept="video/mp4,.mp4" disabled={Boolean(busy)} onChange={(event) => { setUploadFile(event.target.files?.[0] ?? null); setUploadProgress(0); }} />
          </label>
          <button type="button" className="secondary" disabled={Boolean(busy) || !uploadFile} onClick={() => void uploadVideo()}>
            {busy === "upload-video" ? `Uploading… ${uploadProgress}%` : "Upload video"}
          </button>
        </div>}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
        <h2>Generated videos</h2>
        {videos.length === 0 ? <p>No video generations yet.</p> : <div className="story-list">
          {videos.map((video) => <article className="story-card" key={video._id}>
            <h3>{new Date(video.created_at).toLocaleString()} · {video.source === "upload" ? "Uploaded video" : video.status.replaceAll("_", " ")}</h3>
            {video.drive_url && <p><a href={video.drive_url} target="_blank" rel="noreferrer">Open video in Google Drive</a></p>}
            {video.drive_file_id && <p>Stored file reference: {video.drive_file_id}</p>}
            {video.youtube_url && <p>
              <a href={video.youtube_url} target="_blank" rel="noreferrer">Open on YouTube</a>
              {" · "}{video.youtube_privacy_status}
              {video.youtube_channel_title ? ` · ${video.youtube_channel_title}` : ""}
              {video.youtube_playlist_title ? ` · ${video.youtube_playlist_title}` : ""}
            </p>}
            {video.youtube_upload_status === "uploading" && <p role="status">Uploading to YouTube…</p>}
            {video.youtube_error && <p role="alert">{video.youtube_error}</p>}
            {owner && youtube?.connected && video.status === "complete" && content.youtubeTitle && youtubeSettings?.channel_id &&
              video.youtube_upload_status !== "published" &&
              <button type="button" className="secondary" disabled={Boolean(busy) || video.youtube_upload_status === "uploading"} onClick={() => void post("publish-youtube", toPayload(), { videoId: video._id, privacyStatus })}>
                {video.youtube_upload_status === "playlist_failed" ? "Retry playlist add" : video.youtube_upload_status === "failed" ? "Retry YouTube upload" : `Upload to YouTube (${privacyStatus})`}
              </button>}
            {video.source !== "upload" && <details><summary>Prompt used for this generation</summary><pre className="artifact-preview">{video.prompt}</pre></details>}
            {video.error && <p role="alert">{video.error}</p>}
            {owner && video.status === "upload_failed" && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void refreshVideo(video._id)}>Retry Google Drive upload</button>}
            {activeStatuses.has(video.status) && <p role="status">{owner ? "Generation status refreshes automatically." : "Generation status updates when the owner opens this story."}</p>}
          </article>)}
        </div>}
      </>}
    </section>
  );
}
