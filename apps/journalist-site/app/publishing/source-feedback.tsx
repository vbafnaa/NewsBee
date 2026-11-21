"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { adminApi } from "@/lib/admin-client";
import { usePublicationWriteAccess, type PublicationWriteAccess } from "@/lib/use-publication-write-access";

type Source = { source_id: string; location_id: string; name: string; url: string | null; section: string };
type Feedback = {
  _id: string;
  source_name_snapshot: string;
  location_name: string;
  category: string;
  message: string;
  status: "pending" | "approved" | "rejected";
  reason?: string | null;
  submitted_at: string;
};
type Data = { publication: PublicationWriteAccess; sources: Source[]; feedback: Feedback[] };

export default function PublicationSourceFeedback({ publicationId }: { publicationId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [sourceKey, setSourceKey] = useState("");
  const [category, setCategory] = useState("incorrect_details");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const canWrite = usePublicationWriteAccess(data?.publication ?? null);
  const load = useCallback(async () => {
    try {
      const result = await adminApi<Data>(`output-channels/${encodeURIComponent(publicationId)}/source-feedback`);
      setData(result);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [publicationId]);
  useEffect(() => { void load(); }, [load]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) { setError("Feedback is read-only. Refresh access before submitting; your message has been kept."); return; }
    const source = data?.sources.find((item) => `${item.location_id}:${item.source_id}` === sourceKey);
    if (!source) { setError("Choose an available source before submitting feedback."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await adminApi(`output-channels/${encodeURIComponent(publicationId)}/source-feedback`, {
        method: "POST",
        body: JSON.stringify({ location_id: source.location_id, source_id: source.source_id, category, message }),
      });
      setMessage("");
      setNotice("Feedback submitted for administrative review. The source was not changed.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  return <section className="panel" aria-labelledby="source-feedback-title">
    <div className="section-heading"><div><h2 id="source-feedback-title">Source feedback</h2>
      <p>Ask an administrator to review a source. Acknowledgement does not change the shared source.</p></div></div>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!data && (error ? <button type="button" className="secondary" onClick={() => void load()}>Retry loading feedback</button>
      : <p role="status">Loading sources and feedback...</p>)}
    {data && <>
    {!canWrite && <p className="notice" role="status">Read-only inspection or expired support. Your pending message is kept.</p>}
    <form onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy || !canWrite}>
        <legend>Flag a source</legend>
      <div className="filters">
        <label className="field">Source<select required value={sourceKey} onChange={(event) => setSourceKey(event.target.value)}>
          <option value="">Choose a source</option>
          {data?.sources.map((source) => <option key={`${source.location_id}:${source.source_id}`} value={`${source.location_id}:${source.source_id}`}>{source.name} · {source.location_id}</option>)}
        </select></label>
        <label className="field">Category<select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="incorrect_details">Incorrect details</option><option value="stale">Stale</option><option value="unreachable">Unreachable</option><option value="duplicate">Duplicate</option><option value="other">Other</option>
        </select></label>
      </div>
      <label className="field">What should the administrator review?<textarea minLength={5} maxLength={1000} required value={message} onChange={(event) => setMessage(event.target.value)} /></label>
      <button disabled={busy || !sourceKey}>{busy ? "Submitting…" : "Submit source feedback"}</button>
      </fieldset>
    </form>
    <h3>Recent feedback</h3>
    {!data?.feedback.length ? <p>None.</p> : <ul className="alert-list">{data.feedback.map((item) => <li key={item._id}>
      <span><strong>{item.source_name_snapshot}</strong> · {item.location_name} <small>· {item.category.replaceAll("_", " ")} · {item.status === "approved" ? "Acknowledged - source change pending" : item.status === "rejected" ? "Feedback rejected - source unchanged" : "Awaiting review"}</small></span>
      <small>{item.message}</small>
      {item.reason && <small>Review note: {item.reason}</small>}
    </li>)}</ul>}
    </>}
  </section>;
}
