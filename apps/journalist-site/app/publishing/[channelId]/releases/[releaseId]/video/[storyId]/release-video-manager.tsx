"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePublicationWriteAccess, type PublicationWriteAccess } from "@/lib/use-publication-write-access";

type ContentPackage = {
  youtubeTitle: string;
  youtubeDescription: string;
  youtubeTags: string[];
  tiktokCaption: string;
  spokenScript: string;
  videoPrompt: string;
  subtitlesSrt: string;
};
type Video = {
  _id: string;
  status: string;
  source?: "upload";
  provider?: "fal" | "desktop";
  funding_identity?: "managed" | "personal";
  error?: string;
  stale?: boolean;
  canRefresh?: boolean;
  canReplace?: boolean;
  legacyUnavailable?: boolean;
  drive_file_id?: string;
  drive_url?: string;
  replacement_of?: string;
  replaced_by?: string;
};
type Data = {
  detail?: string;
  story?: { title: string; summary: string; locationName: string };
  package?: ContentPackage | null;
  videos?: Video[];
  video?: Video | null;
  cacheHash?: string;
  releaseHash?: string;
  packageRevision?: number;
  packageHash?: string;
  principalRole?: "owner" | "admin" | "editor";
  canWrite?: boolean;
  supportExpiresAt?: number | null;
  falConfigured?: boolean;
  falUnavailableReason?: string | null;
  desktopConfigured?: boolean;
  desktopFunding?: "managed" | "personal" | null;
  desktopUnavailableReason?: string | null;
  model?: string;
  uploadId?: string;
};
const emptyPackage: ContentPackage = {
  youtubeTitle: "",
  youtubeDescription: "",
  youtubeTags: [],
  tiktokCaption: "",
  spokenScript: "",
  videoPrompt: "",
  subtitlesSrt: "",
};
const active = new Set(["submitting", "queued", "processing", "uploading", "upload_failed"]);
const providerNames = { fal: "fal.ai", desktop: "Desktop Video" };
const uploadChunkBytes = 2 * 1024 * 1024;
const maxUploadBytes = 100 * 1024 * 1024;

export default function ReleaseVideoManager({
  publicationId,
  releaseId,
  storyId,
}: {
  publicationId: string;
  releaseId: string;
  storyId: string;
}) {
  const endpoint = `/api/admin/publications/${encodeURIComponent(publicationId)}/releases/${encodeURIComponent(releaseId)}/video/${encodeURIComponent(storyId)}`;
  const [story, setStory] = useState<Data["story"]>(undefined);
  const [content, setContent] = useState<ContentPackage>(emptyPackage);
  const [videos, setVideos] = useState<Video[]>([]);
  const [cacheHash, setCacheHash] = useState("");
  const [releaseHash, setReleaseHash] = useState("");
  const [packageRevision, setPackageRevision] = useState(0);
  const [packageHash, setPackageHash] = useState("");
  const [principalRole, setPrincipalRole] = useState<"owner" | "admin" | "editor">("editor");
  const [access, setAccess] = useState<PublicationWriteAccess | null>(null);
  const canWrite = usePublicationWriteAccess(access);
  const [falConfigured, setFalConfigured] = useState(false);
  const [falUnavailableReason, setFalUnavailableReason] = useState("");
  const [desktopConfigured, setDesktopConfigured] = useState(false);
  const [desktopFunding, setDesktopFunding] = useState<"managed" | "personal" | null>(null);
  const [desktopUnavailableReason, setDesktopUnavailableReason] = useState("");
  const [provider, setProvider] = useState<"fal" | "desktop">("desktop");
  const [model, setModel] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirtyRef = useRef(false);
  const providerInitialized = useRef(false);

  const load = useCallback(async (preserveDirty = true) => {
    const response = await fetch(endpoint);
    const data = await response.json() as Data;
    if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
    setStory(data.story);
    if (!preserveDirty || !dirtyRef.current) {
      setContent(data.package ?? emptyPackage);
      setPackageRevision(data.packageRevision ?? 0);
      setPackageHash(data.packageHash ?? "");
    }
    setVideos(data.videos ?? []);
    setCacheHash(data.cacheHash ?? "");
    setReleaseHash(data.releaseHash ?? "");
    setPrincipalRole(data.principalRole ?? "editor");
    setAccess({ canWrite: data.canWrite === true, supportExpiresAt: data.supportExpiresAt ?? null });
    setFalConfigured(Boolean(data.falConfigured));
    setFalUnavailableReason(data.falUnavailableReason ?? "");
    setDesktopConfigured(Boolean(data.desktopConfigured));
    setDesktopFunding(data.desktopFunding ?? null);
    setDesktopUnavailableReason(data.desktopUnavailableReason ?? "");
    setModel(data.model ?? "");
    if (!providerInitialized.current) {
      const newestProvider = data.videos?.[0]?.provider ?? (data.videos?.[0]?.source === "upload" ? undefined : "fal");
      const newestAvailable = newestProvider === "desktop"
        ? Boolean(data.desktopConfigured)
        : newestProvider === "fal"
          ? Boolean(data.falConfigured)
          : false;
      setProvider(newestAvailable ? newestProvider! : data.desktopConfigured ? "desktop" : "fal");
      providerInitialized.current = true;
    }
  }, [endpoint]);
  useEffect(() => { void load(false).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))); }, [load]);

  const pendingIds = useMemo(() => ({
    fal: videos.filter((video) => (video.provider ?? "fal") === "fal" && video.canRefresh && active.has(video.status)).map((video) => video._id),
    desktop: videos.filter((video) => video.provider === "desktop" && video.canRefresh && active.has(video.status)).map((video) => video._id),
  }), [videos]);
  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const schedule = (ids: string[], delay: number) => {
      if (!ids.length) return;
      const poll = async () => {
        if (cancelled) return;
        for (const videoId of ids) {
          if (cancelled) return;
          await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "refresh-video", videoId }),
          });
        }
        await load(true);
        if (!cancelled) timers.push(window.setTimeout(() => void poll(), delay));
      };
      timers.push(window.setTimeout(() => void poll(), delay));
    };
    if (canWrite && falConfigured) schedule(pendingIds.fal, 6000);
    if (canWrite && desktopConfigured) schedule(pendingIds.desktop, 60_000);
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [canWrite, desktopConfigured, endpoint, falConfigured, load, pendingIds]);

  async function post(action: string, includePackage = false, extra: Record<string, unknown> = {}) {
    if (!canWrite) { setError("Video Studio is read-only or support access expired. Your package edits are kept."); return; }
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          expectedRevision: packageRevision,
          expectedPackageHash: packageHash,
          ...(includePackage ? { package: content } : {}),
          ...extra,
        }),
      });
      const data = await response.json() as Data;
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      if (data.package) setContent(data.package);
      setPackageRevision(data.packageRevision ?? packageRevision);
      setPackageHash(data.packageHash ?? packageHash);
      dirtyRef.current = false;
      if (action === "generate-content") {
        setReviewed(false);
        setNotice("Package created from the immutable release story. Review the script, video prompt, and captions.");
      } else if (action === "save-package") {
        setNotice("Release video package saved.");
      } else if (action === "generate-video") {
        setNotice(`Video generation submitted to ${providerNames[provider]}.`);
      } else if (action === "replace-video") {
        setNotice("A replacement Desktop Video job was submitted with the current credential policy. The unavailable job remains in history.");
      }
      await load(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function uploadVideo() {
    if (!canWrite) { setError("Video Studio is read-only or support access expired. Your selected file is kept."); return; }
    if (!uploadFile) return;
    setBusy("upload-video");
    setError("");
    setNotice("");
    setUploadProgress(0);
    try {
      if (!uploadFile.name.toLowerCase().endsWith(".mp4") || uploadFile.type !== "video/mp4"
        || !uploadFile.size || uploadFile.size > maxUploadBytes) {
        throw new Error("Choose an MP4 video no larger than 100 MB.");
      }
      const start = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start-upload", size: uploadFile.size }),
      });
      const started = await start.json() as Data;
      if (!start.ok || !started.uploadId) throw new Error(started.detail ?? "Could not start video upload.");
      const count = Math.ceil(uploadFile.size / uploadChunkBytes);
      for (let index = 0; index < count; index += 1) {
        const url = new URL(endpoint, window.location.origin);
        url.searchParams.set("action", "upload-chunk");
        url.searchParams.set("uploadId", started.uploadId);
        url.searchParams.set("index", String(index));
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: uploadFile.slice(index * uploadChunkBytes, (index + 1) * uploadChunkBytes),
        });
        if (!response.ok) {
          const result = await response.json() as Data;
          throw new Error(result.detail ?? `Upload failed (${response.status}).`);
        }
        setUploadProgress(Math.round((index + 1) / count * 100));
      }
      const finish = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finish-upload", uploadId: started.uploadId }),
      });
      const finished = await finish.json() as Data;
      if (!finish.ok) throw new Error(finished.detail ?? `Could not save video (${finish.status}).`);
      setUploadFile(null);
      setNotice("The MP4 is stored in Newsbee for this publication, immutable release, and story.");
      await load(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  return <section className="workspace-section">
    <div className="section-heading">
      <div><p className="eyebrow">Published story</p><h2>{story?.title ?? "Loading story…"}</h2>
        {story?.summary && <details><summary>Read the source story</summary><p style={{ whiteSpace: "pre-wrap" }}>{story.summary}</p></details>}
      </div>
      <Link className="button secondary" href={`/newsroom/${encodeURIComponent(publicationId)}/releases/${encodeURIComponent(releaseId)}`}>Choose another story</Link>
    </div>
    <p>Create a script, review it, then choose whether to generate a video. Videos stay separate from the Reader edition; nothing is emailed or posted automatically.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {access && !canWrite && <p className="notice" role="status">Read-only inspection or expired support. Generation, uploads and provider polling are disabled; existing package edits are kept.</p>}
    {access && !canWrite && principalRole !== "editor" && <p><Link href={`/admin/publication-governance?publicationId=${encodeURIComponent(publicationId)}`}>Review this newsroom's access and deliberate support options</Link>. Archived newsrooms must be restored before changes.</p>}
    <details><summary>Provider policy and technical details</summary>
    <p className="chart-caption">Release <code>{releaseHash.slice(0, 16)}</code> · package cache <code>{cacheHash.slice(0, 16)}</code></p>
    <p>{principalRole === "admin"
      ? "Admins always use their own model and video keys, even in an assigned newsroom. Managed-service fallback is not available."
      : principalRole === "owner"
        ? "The Owner uses deployed model defaults and the managed Desktop Video fallback unless personally overridden."
        : "Assigned Journalists use newsroom-managed model services and Desktop Video when configured; personal API settings are not required."}</p>
    </details>
    {!content.spokenScript ? <>
      <p>Creating a script uses AI model services and may consume {principalRole === "admin" ? "your personal provider quota" : principalRole === "owner" ? "your configured model quota" : "the newsroom's managed allowance"}. It does not generate a video.</p>
      <button type="button" disabled={!canWrite || busy !== ""} onClick={() => void post("generate-content")}>{busy === "generate-content" ? "Creating script…" : "Create script and captions"}</button>
    </> : <fieldset disabled={!canWrite} className="workspace-card">
      <h3>Script and captions</h3>
      <label>Spoken script<textarea rows={6} value={content.spokenScript} onChange={(event) => {
        setContent({ ...content, spokenScript: event.target.value });
        dirtyRef.current = true;
        setReviewed(false);
      }} /></label>
      <label>Video prompt<textarea rows={12} value={content.videoPrompt} onChange={(event) => {
        setContent({ ...content, videoPrompt: event.target.value });
        dirtyRef.current = true;
        setReviewed(false);
      }} /></label>
      <label>Captions (SRT)<textarea rows={12} value={content.subtitlesSrt} onChange={(event) => {
        setContent({ ...content, subtitlesSrt: event.target.value });
        dirtyRef.current = true;
        setReviewed(false);
      }} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I reviewed the script, video prompt, and captions.</label>
      <label>Video generation method<select value={provider} disabled={busy !== ""} onChange={(event) => setProvider(event.target.value === "fal" ? "fal" : "desktop")}>
        <option value="desktop">Desktop Video · MiniMax H3 · 15 seconds · 9:16 portrait{desktopConfigured ? "" : " · unavailable"}</option>
        <option value="fal">fal.ai · {model || "configured model"} · 15 seconds · 9:16 portrait{falConfigured ? "" : " · unavailable"}</option>
      </select></label>
      <div className="card-actions">
        <button type="button" className="secondary" disabled={busy !== ""} onClick={() => void post("save-package", true)}>Save script and captions</button>
        <button type="button" disabled={busy !== "" || !reviewed || (provider === "desktop" ? !desktopConfigured : !falConfigured)}
          onClick={() => void post("generate-video", true, { provider })}>
          Generate {provider === "desktop" ? "MiniMax H3" : model || "fal.ai"} video
        </button>
      </div>
      <p>Generating a video submits a job to the selected provider and may incur charges against {provider === "desktop" && desktopFunding === "managed" ? "the newsroom's managed funding" : "your configured provider account"}. It does not publish the video.</p>
      {provider === "desktop" && desktopConfigured && <p className="notice">{principalRole === "editor"
        ? "Newsbee-managed Desktop Video is provided by the newsroom; no personal API settings are required."
        : `Desktop Video uses ${desktopFunding === "personal" ? "your configured personal credential" : "the existing owner managed fallback"}.`} Completed jobs retain only a validated Google Drive link.</p>}
      {provider === "desktop" && !desktopConfigured && <p className="alert">{desktopUnavailableReason || "Newsbee-managed Desktop Video is not configured."}</p>}
      {provider === "fal" && !falConfigured && <p className="notice">{falUnavailableReason || (principalRole !== "editor"
        ? "Add your personal fal.ai API key in Environment & API settings before generating."
        : "fal.ai is not enabled for this editor. Use Newsbee-managed Desktop Video when it is available.")}</p>}
      <div className="panel">
        <h3>Upload a completed MP4</h3>
        <p>For Desktop Video, download the file from Google Drive, then upload it here. Newsbee never fetches or publishes the Drive file automatically.</p>
        <input type="file" accept="video/mp4,.mp4" disabled={busy !== ""} onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} />
        <button type="button" className="secondary" disabled={busy !== "" || !uploadFile} onClick={() => void uploadVideo()}>
          {busy === "upload-video" ? `Uploading ${uploadProgress}%` : "Upload MP4 to this release story"}
        </button>
        {busy === "upload-video" && <label>Upload progress
          <progress max="100" value={uploadProgress}>{uploadProgress}%</progress>
        </label>}
      </div>
    </fieldset>}
    {videos.length > 0 && <section className="workspace-card">
      <h3>Generated previews</h3>
      <ol className="edition-list">{videos.map((video) => <li key={video._id}>
        <div>
          <strong>{video.source === "upload" ? "Uploaded MP4" : `${providerNames[video.provider ?? "fal"]} · ${video.status}`}</strong>
          {video.funding_identity && <p className="chart-caption">{video.funding_identity === "managed" ? "Provided by the newsroom" : "Personal provider credential"}</p>}
          {video.stale && <p className="alert">Stale output: the release, template, or edited package no longer matches this video.</p>}
          {video.error && <p className="alert">{video.error}</p>}
          {video.legacyUnavailable && <p className="alert">Original job unavailable: the personal Desktop credential is missing or changed. Newsbee did not call the provider or spend managed funds.</p>}
          {video.drive_url && <p><a href={video.drive_url} target="_blank" rel="noreferrer">Open completed video in Google Drive</a></p>}
          {video.provider === "desktop" && video.status === "complete" && video.drive_url && <p>Download the MP4 from Google Drive, then upload it above to store it with this release story for review. This does not add it to the Reader edition. Newsbee never imports the Drive file automatically.</p>}
          {video.status === "complete" && video.drive_file_id && <video controls preload="metadata" style={{ width: "100%", maxWidth: "28rem" }} src={`${endpoint}?preview=${encodeURIComponent(video._id)}`} />}
          {video.replacement_of && <p className="chart-caption">This job is the requested replacement for an earlier unavailable Desktop Video job.</p>}
          {video.replaced_by && <p className="chart-caption">A replacement was generated; this history remains preserved.</p>}
        </div>
        <div className="card-actions">
          {video.status === "complete" && video.drive_file_id && <a className="button secondary" href={`${endpoint}?download=${encodeURIComponent(video._id)}`}>Download MP4</a>}
          {video.canReplace && <button type="button" className="secondary" disabled={!canWrite || busy !== "" || !desktopConfigured}
            onClick={() => void post("replace-video", true, { videoId: video._id })}>Generate replacement</button>}
        </div>
      </li>)}</ol>
    </section>}
    <p className="chart-caption">This contained flow does not publish to social platforms, transcribe media, or provide a timeline editor.</p>
  </section>;
}
