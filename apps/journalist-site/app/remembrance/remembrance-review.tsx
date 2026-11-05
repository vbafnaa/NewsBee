"use client";

import { useCallback, useEffect, useState } from "react";

type Submission = {
  _id: string; location_id: string; location_name: string; person_name: string; notice: string; link: string | null;
  submitter_name: string; submitter_email: string; relationship: string; status: "pending" | "approved" | "rejected";
  submitted_at: string; decided_at?: string | null; decided_by?: string | null; reason?: string | null;
};

export default function RemembranceReview({ locationId }: { locationId?: string }) {
  const [status, setStatus] = useState<"pending" | "all">("pending");
  const [items, setItems] = useState<Submission[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/remembrance?status=${status}${locationId ? `&location=${encodeURIComponent(locationId)}` : ""}`, { cache: "no-store" });
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
      const response = await fetch("/api/admin/remembrance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, decision, reason }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(""); }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div><h2>Submitted notices</h2><p>Families submit notices at <code>/reader/remember?location=…</code>. The submitter&apos;s name and email are never published.</p></div>
        <label className="field"><span>Show</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as "pending" | "all")}>
            <option value="pending">Waiting for review</option><option value="all">All</option>
          </select>
        </label>
      </div>
      {error && <p className="alert" role="alert">{error}</p>}
      {!items && !error && <p role="status">Loading submissions...</p>}
      {items?.length === 0 && <p>No submissions {status === "pending" ? "are waiting for review" : "yet"}.</p>}
      <div className="location-run-list">
        {items?.map((item) => (
          <article className="connector-card" key={item._id}>
            <h3>In memory: {item.person_name}</h3>
            <p className="eyebrow">{item.location_name} · submitted {new Date(item.submitted_at).toLocaleString()} · {item.status}</p>
            <p style={{ whiteSpace: "pre-wrap" }}>{item.notice}</p>
            {item.link && <p><a href={item.link} target="_blank" rel="noreferrer">{item.link}</a></p>}
            <p>From {item.submitter_name} ({item.relationship}) · <a href={`mailto:${item.submitter_email}`}>{item.submitter_email}</a></p>
            {item.decided_by && <p>Decided by {item.decided_by}{item.reason ? `: ${item.reason}` : ""}</p>}
            {item.status === "pending" && <div className="actions">
              <button type="button" disabled={busy === item._id} onClick={() => void decide(item._id, "approved")}>Approve for publication</button>
              <button type="button" className="secondary" disabled={busy === item._id} onClick={() => void decide(item._id, "rejected")}>Reject</button>
            </div>}
          </article>
        ))}
      </div>
    </section>
  );
}
