"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Story = {
  storyId: string;
  editionId: string;
  title: string;
  summary: string;
  eventDate: string;
  sourceUrl: string | null;
  hasPackage: boolean;
};
type ResponseData = { detail?: string; stories?: Story[]; falConfigured?: boolean; model?: string };

/**
 * A selected location's published stories with video packages to prepare. Making videos uses the
 * deployment's video key, so only the owner can; each video is listed in its edition's funnel.
 */
export default function VideoStudio({ locationId, owner }: { locationId: string; owner: boolean }) {
  const [stories, setStories] = useState<Story[] | null>(null);
  const [falConfigured, setFalConfigured] = useState(true);
  const [model, setModel] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setStories(null); setError("");
    void fetch(`/api/admin/video-production?locationId=${encodeURIComponent(locationId)}`).then(async (response) => {
      const data = await response.json() as ResponseData;
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      if (!live) return;
      setStories(data.stories ?? []);
      setFalConfigured(Boolean(data.falConfigured));
      setModel(data.model ?? "");
    }).catch((caught: unknown) => { if (live) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { live = false; };
  }, [locationId]);

  return (
    <section className="panel">
      <h2>Videos</h2>
      <p className="chart-caption">From published stories{model ? ` · ${model}` : ""}. {owner ? "Check speech and subtitles before posting." : "Video creation is available to the owner."}</p>
      {!falConfigured && <p className="notice" role="status">Add a fal.ai key in <Link href="/account">Environment &amp; API settings</Link> to make videos. Only the configured owner may use the server&apos;s <code>FAL_KEY</code>.</p>}
      {error && <p className="alert" role="alert">{error}</p>}
      {!stories && !error && <p role="status">Loading…</p>}
      {stories?.length === 0 &&             <p>No published stories yet. <Link href={`/locations/${encodeURIComponent(locationId)}?tab=published`}>Publish an edition</Link>.</p>}
      {stories && stories.length > 0 && <div className="story-list">
        {stories.map((story) => (
          <article className="story-card" key={`${story.editionId}:${story.storyId}`}>
            <h3>{story.title}</h3>
            <p>{story.summary}</p>
            <p className="eyebrow">{story.eventDate || "No date"}</p>
            <Link className="button" href={`/video-studio/${encodeURIComponent(locationId)}/${encodeURIComponent(story.storyId)}`}>
              {story.hasPackage ? "View video" : owner ? "Make video" : "View story"}
            </Link>
          </article>
        ))}
      </div>}
    </section>
  );
}
