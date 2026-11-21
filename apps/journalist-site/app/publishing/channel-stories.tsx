"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";

type Story = {
  locationId: string;
  locationName: string;
  storyId: string;
  editionId: string;
  title: string;
  summary: string;
  eventDate: string;
  hasPackage: boolean;
  published: boolean;
};
type Data = {
  stories: Story[];
  availableOutputs: Array<"reader" | "video">;
  enabled: boolean;
  videoPromptTemplate: string;
  defaultVideoPromptTemplate: string;
};

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const storyKey = ({ locationId, editionId, storyId }: Story) => `${locationId}:${editionId}:${storyId}`;

export default function ChannelStories({ channelId }: { channelId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [busyStory, setBusyStory] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [template, setTemplate] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateMessage, setTemplateMessage] = useState("");
  const [templateError, setTemplateError] = useState("");
  const endpoint = `output-channels/${encodeURIComponent(channelId)}/editions`;

  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    void adminApi<Data>(endpoint)
      .then((result) => {
        if (!active) return;
        setData(result);
        setTemplate(result.videoPromptTemplate);
      })
      .catch((cause) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [endpoint]);

  async function saveTemplate(value: string | null) {
    setSavingTemplate(true);
    setTemplateError("");
    setTemplateMessage("");
    try {
      const result = await adminApi<{ videoPromptTemplate: string }>(endpoint, {
        method: "PATCH",
        body: JSON.stringify({ videoPromptTemplate: value }),
      });
      setTemplate(result.videoPromptTemplate);
      setData((current) => current && ({ ...current, videoPromptTemplate: result.videoPromptTemplate }));
      setTemplateMessage(value === null ? "Default template restored." : "Channel video prompt template saved.");
    } catch (cause) {
      setTemplateError(errorText(cause));
    } finally {
      setSavingTemplate(false);
    }
  }

  async function publish(story: Story) {
    const key = storyKey(story);
    setBusyStory(key);
    setError("");
    setNotice("");
    try {
      await adminApi(endpoint, {
        method: "POST",
        body: JSON.stringify({
          title: story.title,
          stories: [{ locationId: story.locationId, storyId: story.storyId, editionId: story.editionId }],
          outputModes: ["reader"],
          videoStories: [],
        }),
      });
      setData((current) => current && ({ ...current, stories: current.stories.map((item) =>
        storyKey(item) === key ? { ...item, published: true } : item) }));
      setNotice(`Published "${story.title}" to this channel.`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusyStory(null);
    }
  }

  return <section className="panel channel-edition-creator">
    <h2>Channel stories</h2>
    <p>Stories from the latest published edition of each selected community. Publish stories individually to this channel, or open their video workflow.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!data && !error && <p role="status">Loading channel stories…</p>}
    {data && <>
      <details>
        <summary>Channel video prompt template</summary>
        <p>This template is used when you generate a video prompt for a story in this channel.</p>
        <label className="field">
          Video prompt template
          <textarea rows={14} maxLength={12000} value={template} disabled={savingTemplate}
            onChange={(event) => { setTemplate(event.target.value); setTemplateMessage(""); setTemplateError(""); }} />
        </label>
        <p>Include <code>{"{{dialogue}}"}</code> for the exact script. You can also insert <code>{"{{location}}"}</code>, <code>{"{{duration}}"}</code>, and <code>{"{{editorialDirection}}"}</code>.</p>
        <div className="card-actions">
          <button type="button" disabled={savingTemplate || template.trim() === data.videoPromptTemplate}
            onClick={() => void saveTemplate(template)}>{savingTemplate ? "Saving…" : "Save channel template"}</button>
          <button type="button" className="secondary" disabled={savingTemplate || template === data.defaultVideoPromptTemplate}
            onClick={() => void saveTemplate(null)}>Restore default template</button>
        </div>
        {templateMessage && <p role="status">{templateMessage}</p>}
        {templateError && <p className="alert" role="alert">{templateError}</p>}
      </details>
      {!data.enabled && <p className="notice" role="status">Enable this channel in its settings before publishing a story.</p>}
      {data.stories.length === 0
        ? <p>No published stories in the selected communities yet. Publish a location edition first.</p>
        : <ul className="edition-list" aria-label="Channel stories">{data.stories.map((story) => <li key={storyKey(story)}>
          <div>
            <strong>{story.title}</strong>
            <p className="chart-caption">{story.locationName} · {story.eventDate || "No date"}{story.hasPackage ? " · video package ready" : ""}</p>
            {story.summary && <p>{story.summary}</p>}
            <div className="card-actions">
              {data.availableOutputs.includes("reader") && <button type="button"
                disabled={!data.enabled || story.published || busyStory !== null}
                onClick={() => void publish(story)}>
                {busyStory === storyKey(story) ? "Publishing…" : story.published ? "Published" : "Publish"}
              </button>}
              <Link className="button"
                href={`/video-studio/${encodeURIComponent(story.locationId)}/${encodeURIComponent(story.storyId)}?channel=${encodeURIComponent(channelId)}`}>
                Start video editing
              </Link>
            </div>
          </div>
        </li>)}</ul>}
    </>}
  </section>;
}
