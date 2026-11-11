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
};

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const storyKey = ({ locationId, editionId, storyId }: Story) => `${locationId}:${editionId}:${storyId}`;

export default function ChannelStories({ channelId, owner }: { channelId: string; owner: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [busyStory, setBusyStory] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    void adminApi<Data>(`output-channels/${encodeURIComponent(channelId)}/editions`)
      .then((result) => { if (active) setData(result); })
      .catch((cause) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [channelId]);

  async function publish(story: Story) {
    const key = storyKey(story);
    setBusyStory(key);
    setError("");
    setNotice("");
    try {
      await adminApi(`output-channels/${encodeURIComponent(channelId)}/editions`, {
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
              {data.availableOutputs.includes("video") && <Link className="button"
                href={`/video-studio/${encodeURIComponent(story.locationId)}/${encodeURIComponent(story.storyId)}?channel=${encodeURIComponent(channelId)}`}>
                {owner ? "Generate video" : "View video workflow"}
              </Link>}
            </div>
          </div>
        </li>)}</ul>}
    </>}
  </section>;
}
