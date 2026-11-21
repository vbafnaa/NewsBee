"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import { EMAIL_UNAVAILABLE } from "../../../../../../../shared/email-availability";
import RetainedDisclosure from "@/app/components/retained-disclosure";
import { newsroomEditionHref } from "@/app/newsroom/newsroom-routes";

type Campaign = {
  _id: string;
  release_id: string;
  mode: "release" | "test";
  state: string;
  recipient_count: number;
  counts: Record<string, number>;
  created_at: number;
};
type EmailData = {
  campaigns?: Campaign[];
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function ReleaseDistribution({
  publicationId,
  draftId,
  releaseId,
  releaseHash,
  title,
  stories,
}: {
  publicationId: string;
  draftId: string;
  releaseId: string;
  releaseHash: string;
  title: string;
  stories: Array<{ id: string; headline: string; locations: string[] }>;
}) {
  return <section className="workspace-section">
    <div className="section-heading">
      <div>
        <p className="eyebrow">Published edition</p>
        <h2>{title}</h2>
        <details><summary>Release details</summary><p className="chart-caption">Release <code>{releaseId}</code> · content <code>{releaseHash.slice(0, 16)}</code></p></details>
      </div>
      <Link className="button secondary" href={newsroomEditionHref(publicationId, draftId)}>Back to edition</Link>
    </div>

    <section className="workspace-card">
      <p className="eyebrow">Optional after publication</p>
      <h3>Choose a story</h3>
      <p>Create a script and captions from a published story, then review them before generating a video. Opening a story does not start generation or spend funds.</p>
      <p>Videos stay separate from the published Reader edition. Creating one does not send email or post to social platforms.</p>
      <details><summary>Services and release safety</summary>
        <p>Assigned Journalists use newsroom-managed services when available. Admins always use personal provider keys, even when assigned; the Owner uses deployed defaults unless personally overridden. Access and provider availability are checked inside the selected story.</p>
        <p>Packages are reused only for the same release, story and template. This flow does not change the edition. An optional Save the Bee game can be added in the edition editor before publication; community games are not imported automatically.</p>
      </details>
      <ol className="edition-list">{stories.map((story) => <li key={story.id}>
        <div><strong>{story.headline}</strong><p className="chart-caption">{story.locations.join(" · ")}</p></div>
        <Link className="button secondary" aria-label={`Create video for ${story.headline}`} href={`/newsroom/${encodeURIComponent(publicationId)}/releases/${encodeURIComponent(releaseId)}/video/${encodeURIComponent(story.id)}`}>Create video</Link>
      </li>)}</ol>
      {!stories.length && <p>No published stories are available for this edition.</p>}
    </section>
    <RetainedDisclosure title="Historical email results (read-only)" className="workspace-card release-distribution-history">
      <ReleaseEmailHistory publicationId={publicationId} />
    </RetainedDisclosure>
  </section>;
}

function ReleaseEmailHistory({ publicationId }: { publicationId: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const data = await adminApi<EmailData>(`publications/${encodeURIComponent(publicationId)}/email`);
      setCampaigns(data.campaigns ?? []);
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [publicationId]);
  useEffect(() => { void load(); }, [load]);
  return <>
    <p>{EMAIL_UNAVAILABLE} Historical results are read-only.</p>
    {error ? <div role="alert"><p className="alert">{error}</p><button type="button" className="secondary" onClick={() => void load()}>Retry loading results</button></div>
      : campaigns === null ? <p role="status">Loading historical results...</p>
      : campaigns.length === 0 ? <p>No historical campaigns.</p>
      : <table>
        <thead><tr><th>Release</th><th>Mode</th><th>State</th><th>Recipients</th><th>Outcomes</th></tr></thead>
        <tbody>{campaigns.map((campaign) => <tr key={campaign._id}>
          <td>{campaign.release_id}</td>
          <td>{campaign.mode}</td>
          <td>{campaign.state}</td>
          <td>{campaign.recipient_count}</td>
          <td>{Object.entries(campaign.counts).map(([status, count]) => `${status}: ${count}`).join(" · ") || "none"}</td>
        </tr>)}</tbody>
      </table>}
  </>;
}
