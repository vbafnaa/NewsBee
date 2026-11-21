"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CommunityIntake, IntakeKind, IntakeStatus } from "../../../../shared/community-intake";

type IntakeRow = Omit<CommunityIntake, "dedupe_key">;
type InboxResult = { items: IntakeRow[]; total: number; page: number; pages: number };
const statusLabel: Record<IntakeStatus, string> = { pending: "Waiting for review", in_review: "In review", closed: "Closed" };
const intentLabel = { contribute: "Contribute stories", lead: "Help lead an edition", start_branch: "Start a local branch" };

function ReviewCard({ item, saving, disabled, onSave }: { item: IntakeRow; saving: boolean; disabled: boolean; onSave: (item: IntakeRow, status: IntakeStatus, note: string) => Promise<void> }) {
  const [status, setStatus] = useState(item.status), [note, setNote] = useState(item.review_note ?? "");
  return <article className="connector-card" style={{ overflowWrap: "anywhere" }}>
    <h3>{item.kind === "editor_interest" ? "Editor / branch application" : "Community message"}: {item.community_name ?? "General inquiry"}</h3>
    <p className="eyebrow">{new Date(item.submitted_at).toLocaleString()} · {statusLabel[item.status]}</p>
    <p>From {item.submitter_name} · <a href={`mailto:${item.submitter_email}`}>{item.submitter_email}</a></p>
    {item.kind === "editor_interest" ? <>
      <p><strong>Interested in:</strong> {item.intent ? intentLabel[item.intent] : "Local Newsbee"}</p>
      <h4>Experience</h4><p style={{ whiteSpace: "pre-wrap" }}>{item.experience}</p>
      <h4>Community and motivation</h4><p style={{ whiteSpace: "pre-wrap" }}>{item.motivation}</p>
      <p className="chart-caption">Review this application and contact the applicant before any branch setup or account invitation. Saving a review status only updates this inquiry.</p>
    </> : <><p><strong>Topic:</strong> {item.topic}</p><p style={{ whiteSpace: "pre-wrap" }}>{item.message}</p></>}
    {item.reviewed_by && <p className="chart-caption">Last reviewed by {item.reviewed_by}{item.reviewed_at ? ` on ${new Date(item.reviewed_at).toLocaleString()}` : ""}.</p>}
    {item.kind === "editor_interest" && item.status === "closed" && item.reviewed_by && <div>
      <p>If separately approved after contacting the applicant, continue in People. Closed is not an approval or consent grant.</p>
      <a href={`/admin/access?${new URLSearchParams({ email: item.submitter_email })}`}>Review account setup in People</a>
      <p>No account, setup link or newsroom assignment is created by this handoff.</p>
    </div>}
    <div className="form-grid">
      <label className="field"><span>Review status</span><select value={status} onChange={event => setStatus(event.target.value as IntakeStatus)} disabled={disabled}>
        <option value="pending">Waiting for review</option><option value="in_review">In review</option><option value="closed">Closed</option>
      </select></label>
      <label className="field"><span>Private review note</span><textarea value={note} onChange={event => setNote(event.target.value)} maxLength={1000} rows={3} disabled={disabled} /></label>
    </div>
    <div className="button-row"><button type="button" disabled={disabled} onClick={() => void onSave(item, status, note)}>{saving ? "Saving..." : "Save review"}</button></div>
  </article>;
}

export default function CommunityIntakeReview() {
  const [kind, setKind] = useState<IntakeKind | "all">("all");
  const [status, setStatus] = useState<IntakeStatus | "all">("pending");
  const [page, setPage] = useState(1), [data, setData] = useState<InboxResult | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState("");
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const requestVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true); setData(null);
    try {
      const response = await fetch(`/api/admin/community-intake?${new URLSearchParams({ kind, status, page: String(page) })}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail ?? "Could not load community inquiries.");
      if (version !== requestVersion.current) return;
      setData(result); setError("");
    } catch (caught) {
      if (version === requestVersion.current) setError(caught instanceof Error ? caught.message : "Could not load inquiries.");
    } finally { if (version === requestVersion.current) setLoading(false); }
  }, [kind, status, page]);
  useEffect(() => { void load(); return () => { requestVersion.current++; }; }, [load]);

  async function save(item: IntakeRow, nextStatus: IntakeStatus, note: string) {
    setBusy(item._id); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/community-intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item._id, status: nextStatus, note }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail ?? "Could not save this review.");
      setMessage("Review saved. Account access and community settings are unchanged.");
      if (data?.items.length === 1 && page > 1 && status !== "all" && status !== nextStatus) setPage(page - 1);
      else await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save this review."); }
    finally { setBusy(""); }
  }

  return <section id="community-inquiries" className="panel" aria-labelledby="community-inquiries-heading">
    <div className="section-heading">
      <div><h2 id="community-inquiries-heading">Community inquiries and editor interest</h2><p>Private contact messages and applications to contribute, lead an edition, or start a local Newsbee.</p></div>
      <div className="button-row">
        <label className="field"><span>Type</span><select value={kind} disabled={Boolean(busy)} onChange={event => { setKind(event.target.value as IntakeKind | "all"); setPage(1); }}>
          <option value="all">All inquiries</option><option value="contact">Contact messages</option><option value="editor_interest">Editor / branch applications</option>
        </select></label>
        <label className="field"><span>Show</span><select value={status} disabled={Boolean(busy)} onChange={event => { setStatus(event.target.value as IntakeStatus | "all"); setPage(1); }}>
          <option value="pending">Waiting for review</option><option value="in_review">In review</option><option value="closed">Closed</option><option value="all">All statuses</option>
        </select></label>
      </div>
    </div>
    {error && <p className="alert" role="alert">{error} <button type="button" className="secondary" onClick={() => void load()}>Retry loading</button></p>}
    {message && <p role="status">{message}</p>}
    {loading && <p role="status">Loading inquiries...</p>}
    {!loading && data?.items.length === 0 && <p>No inquiries match these filters.</p>}
    <div className="location-run-list" aria-busy={loading}>{!loading && data?.items.map(item => <ReviewCard key={`${item._id}:${item.reviewed_at ?? "new"}`} item={item} saving={busy === item._id} disabled={Boolean(busy)} onSave={save} />)}</div>
    {data && data.pages > 1 && <nav className="button-row" aria-label="Inquiry pages">
      <button className="secondary" type="button" disabled={loading || Boolean(busy) || page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
      <span>Page {page} of {data.pages} · {data.total} inquiries</span>
      <button className="secondary" type="button" disabled={loading || Boolean(busy) || page >= data.pages} onClick={() => setPage(page + 1)}>Next</button>
    </nav>}
  </section>;
}
