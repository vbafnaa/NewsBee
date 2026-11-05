"use client";

import { useCallback, useEffect, useState } from "react";

type Submission = {
  _id: string; location_name: string; headline: string; story: string; topic: string; link: string | null; event_date: string | null;
  submitter_name: string; submitter_email: string; credit: "name" | "anonymous"; status: "pending" | "approved" | "rejected";
  submitted_at: string; decided_by?: string | null; reason?: string | null;
  image?: { caption: string; credit: string; permission_confirmed_at: string } | null;
};

export default function NeighbourStoryReview({ locationId }: { locationId?: string }) {
  const [status, setStatus] = useState<"pending" | "all">("pending");
  const [items, setItems] = useState<Submission[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/reader-stories?status=${status}${locationId ? `&location=${encodeURIComponent(locationId)}` : ""}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      setItems(data.submissions as Submission[]); setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, [status, locationId]);
  useEffect(() => { void load(); }, [load]);

  async function decide(id: string, decision: "approved" | "rejected") {
    const reason = decision === "rejected" ? window.prompt("Reason (kept for the editor log, not published)") ?? "" : "";
    setBusy(id);
    try {
      const response = await fetch("/api/admin/reader-stories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, decision, reason }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(""); }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div><h2>Submitted stories</h2><p>Readers submit at <code>/reader/share?location=…</code>, linked from every edition. Names and emails are never published; stories are credited by first name or as &ldquo;a neighbour&rdquo;, as the submitter chose.</p></div>
        <label className="field"><span>Show</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as "pending" | "all")}>
            <option value="pending">Waiting for review</option><option value="all">All</option>
          </select>
        </label>
      </div>
      {error && <p className="alert" role="alert">{error}</p>}
      {!items && !error && <p role="status">Loading submissions...</p>}
      {items?.length === 0 && <p>No stories {status === "pending" ? "are waiting for review" : "yet"}.</p>}
      <div className="location-run-list">
        {items?.map((item) => (
          <article className="connector-card" key={item._id}>
            <h3>{item.headline}</h3>
            <p className="eyebrow">{item.location_name} · {item.topic}{item.event_date ? ` · on ${item.event_date}` : ""} · submitted {new Date(item.submitted_at).toLocaleString()} · {item.status}</p>
            <p style={{ whiteSpace: "pre-wrap" }}>{item.story}</p>
            {item.image && <figure style={{ margin: "1rem 0" }}>
              <img src={`/api/admin/reader-stories/${encodeURIComponent(item._id)}/image`} alt={item.image.caption} loading="lazy" decoding="async"
                style={{ maxWidth: "100%", maxHeight: "24rem", objectFit: "contain" }} />
              <figcaption>{item.image.caption} · Photo credit: {item.image.credit}</figcaption>
              <p className="chart-caption">Publication permission confirmed {new Date(item.image.permission_confirmed_at).toLocaleString()}. Approval publishes this photo and its credit with the story. Check the image and permissions before approving.</p>
            </figure>}
            {item.link && <p><a href={item.link} target="_blank" rel="noreferrer">{item.link}</a></p>}
            <p>From {item.submitter_name} (credit: {item.credit === "name" ? "first name" : "a neighbour"}) · <a href={`mailto:${item.submitter_email}`}>{item.submitter_email}</a></p>
            {item.decided_by && <p>Decided by {item.decided_by}{item.reason ? `: ${item.reason}` : ""}</p>}
            {item.status === "pending" && <div className="actions">
              <button type="button" disabled={busy === item._id} onClick={() => void decide(item._id, "approved")}>Approve for the next edition</button>
              <button type="button" className="secondary" disabled={busy === item._id} onClick={() => void decide(item._id, "rejected")}>Reject</button>
            </div>}
          </article>
        ))}
      </div>
    </section>
  );
}
