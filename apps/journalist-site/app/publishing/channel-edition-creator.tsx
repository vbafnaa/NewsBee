"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { adminApi } from "@/lib/admin-client";

type Story = {
  locationId: string;
  locationName: string;
  storyId: string;
  editionId: string;
  title: string;
  summary: string;
  eventDate: string;
  sourceUrl: string | null;
  hasPackage: boolean;
};
type SavedEdition = {
  id: string;
  title: string;
  createdAt: number;
  outputModes: Array<"reader" | "video">;
  storyCount: number;
  videoStories: Array<{ locationId: string; storyId: string; title: string }>;
};
type Data = {
  stories: Story[];
  editions: SavedEdition[];
  availableOutputs: Array<"reader" | "video">;
  enabled: boolean;
};
type Selection = { locationId: string; storyId: string };

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const storyKey = ({ locationId, storyId }: Selection) => `${locationId}:${storyId}`;

export default function ChannelEditionCreator({ channelId, owner }: { channelId: string; owner: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [readerMode, setReaderMode] = useState(true);
  const [videoMode, setVideoMode] = useState(false);
  const [videoSelected, setVideoSelected] = useState<Selection[]>([]);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      setData(await adminApi<Data>(`output-channels/${encodeURIComponent(channelId)}/editions`));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  useEffect(() => { void load(); }, [channelId]);
  useEffect(() => {
    if (!data) return;
    if (!data.availableOutputs.includes("reader")) setReaderMode(false);
    if (!data.availableOutputs.includes("video")) setVideoMode(false);
    if (data.availableOutputs.includes("video") && !data.availableOutputs.includes("reader")) setVideoMode(true);
  }, [data]);

  const selectedIds = useMemo(() => new Set(selected.map(storyKey)), [selected]);
  const videoSelectedIds = useMemo(() => new Set(videoSelected.map(storyKey)), [videoSelected]);
  const filteredStories = (data?.stories ?? []).filter((story) =>
    `${story.title} ${story.summary} ${story.locationName}`.toLowerCase().includes(query.trim().toLowerCase()));

  function toggleStory(story: Story) {
    const key = storyKey(story);
    if (selectedIds.has(key)) {
      setSelected((current) => current.filter((item) => storyKey(item) !== key));
      setVideoSelected((current) => current.filter((item) => storyKey(item) !== key));
    } else {
      setSelected((current) => [...current, { locationId: story.locationId, storyId: story.storyId }]);
    }
  }

  function toggleVideoStory(story: Story) {
    const key = storyKey(story);
    setVideoSelected((current) => current.some((item) => storyKey(item) === key)
      ? current.filter((item) => storyKey(item) !== key)
      : [...current, { locationId: story.locationId, storyId: story.storyId }]);
  }

  async function createEdition() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const outputModes = [
        ...(readerMode ? ["reader" as const] : []),
        ...(videoMode ? ["video" as const] : []),
      ];
      const result = await adminApi<{ edition: SavedEdition }>(`output-channels/${encodeURIComponent(channelId)}/editions`, {
        method: "POST",
        body: JSON.stringify({ title, stories: selected, outputModes, videoStories: videoSelected }),
      });
      setNotice(`Created "${result.edition.title}" with ${outputModes.map((output) => output === "reader" ? "Reader" : "Video").join(" and ")} output.`);
      setTitle("");
      setSelected([]);
      setVideoSelected([]);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const selectedVideoStories = (data?.stories ?? []).filter((story) => videoSelectedIds.has(storyKey(story)));

  return <section className="panel channel-edition-creator">
    <h2>Create a channel edition</h2>
    <p>Select published stories from this channel's communities, choose Reader mode, and mark any stories to prepare for video generation.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!data && !error && <p role="status">Loading channel stories…</p>}
    {data && <>
      {!data.enabled && <p className="notice" role="status">Enable this channel in its settings before creating an edition.</p>}
      {data.availableOutputs.length === 0 && <p className="alert" role="alert">Add a publishing destination in channel settings first.</p>}
      <fieldset className="channel-destinations">
        <legend>Edition outputs</legend>
        {data.availableOutputs.includes("reader") && <label className="checkbox-label">
          <input type="checkbox" checked={readerMode} onChange={(event) => setReaderMode(event.target.checked)} />
          <span>Reader mode — publish the selected stories as a curated edition</span>
        </label>}
        {data.availableOutputs.includes("video") && <label className="checkbox-label">
          <input type="checkbox" checked={videoMode} onChange={(event) => {
            setVideoMode(event.target.checked);
            if (!event.target.checked) setVideoSelected([]);
          }} />
          <span>Video generation — choose stories below to prepare for YouTube</span>
        </label>}
      </fieldset>
      <label className="field">Find stories
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search story or community" />
      </label>
      {data.stories.length === 0
        ? <p>No published stories in the selected communities yet. Publish an edition from a location workspace first.</p>
        : <div className="channel-story-picker" aria-label="Published stories">
          {filteredStories.map((story) => <div className="channel-story-option" key={storyKey(story)}>
            <label className="channel-story-main">
              <input type="checkbox" checked={selectedIds.has(storyKey(story))} onChange={() => toggleStory(story)} />
              <span><strong>{story.title}</strong><small>{story.locationName} · {story.eventDate || "No date"}{story.hasPackage ? " · video package ready" : ""}</small>
                {story.summary && <small>{story.summary}</small>}</span>
            </label>
            {videoMode && <label className="checkbox-label channel-video-selection">
              <input type="checkbox" disabled={!selectedIds.has(storyKey(story))} checked={videoSelectedIds.has(storyKey(story))}
                onChange={() => toggleVideoStory(story)} />
              <span>Generate video for this story</span>
            </label>}
          </div>)}
          {filteredStories.length === 0 && <p className="chart-caption">No stories match this search.</p>}
        </div>}
      <p className="chart-caption">{selected.length} selected</p>
      <label className="field">Edition title
        <input maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="For example, This week in the community" />
      </label>
      <button type="button" disabled={busy || !data.enabled || !title.trim() || selected.length === 0 ||
        (!readerMode && !videoMode) || (videoMode && videoSelected.length === 0)} onClick={() => void createEdition()}>
        {busy ? "Creating…" : "Create edition"}
      </button>
      {videoMode && <p className="chart-caption">
        Each story marked for video opens the existing package review, video generation, visibility, playlist, and YouTube upload workflow.
        {videoSelected.length > 0 ? ` ${videoSelected.length} selected for video generation.` : " Mark at least one selected story to enable video output."}
      </p>}
      {videoMode && selectedVideoStories.length > 0 && <div className="channel-video-selections">
        <h3>Stories selected for video</h3>
        {selectedVideoStories.map((story) => <div className="card-actions" key={storyKey(story)}>
          <span>{story.locationName}: {story.title}</span>
          <Link className="button" href={`/video-studio/${encodeURIComponent(story.locationId)}/${encodeURIComponent(story.storyId)}?channel=${encodeURIComponent(channelId)}`}>
            {owner ? "Open video & YouTube workflow" : "View video workflow"}
          </Link>
        </div>)}
      </div>}
      <h3>Saved editions</h3>
      {data.editions.length === 0 ? <p>No channel editions created yet.</p> : <ul className="edition-list">
        {data.editions.map((edition) => <li key={edition.id}>
          <div>
            <strong>{edition.title}</strong>
            <p className="chart-caption">{edition.storyCount} stories · {edition.outputModes.map((output) => output === "reader" ? "Reader mode" : "Video generation").join(" + ")} · {new Date(edition.createdAt).toLocaleString()}</p>
            {edition.videoStories.map((story) => <p className="chart-caption" key={storyKey(story)}>
              Video: {story.title} · <Link href={`/video-studio/${encodeURIComponent(story.locationId)}/${encodeURIComponent(story.storyId)}?channel=${encodeURIComponent(channelId)}`}>Open YouTube workflow</Link>
            </p>)}
          </div>
          <span className="status-badge">{edition.outputModes.includes("reader") ? "Saved to channel Drive" : "Video edition"}</span>
        </li>)}
      </ul>}
    </>}
  </section>;
}
