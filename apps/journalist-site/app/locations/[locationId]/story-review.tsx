"use client";

import { useState } from "react";
import { adminApi } from "@/lib/admin-client";
import { SECTIONS } from "@/pipeline/sourcemap/sections";
import { CATEGORY_REQUIRED_FOR, STORY_OTHER_CODES, STORY_REASONS, type StoryDecision } from "@/pipeline/editions/story-reasons";

export type StoryReviewValue = { decision: StoryDecision | null; reason_code: string | null; reason_label: string | null; reason: string | null; category?: string | null; by: string; at: string } | null;
const categoryLabel = (id: string | null | undefined) => SECTIONS.find((section) => section.id === id)?.label ?? id ?? null;

/**
 * Accept or Reject one story a run pulled, with a reason code, a newsletter category and a note. The
 * category starts at the section the pipeline gave the story, if any, and is required on Accept, so a
 * story the pipeline dropped before placing it still says where it belongs. One decision covers every
 * copy of its link.
 */
export default function StoryReview({ runId, itemId, review, section, onSaved }: { runId: string; itemId: string; review: StoryReviewValue; section?: string | null; onSaved?: (review: StoryReviewValue) => void }) {
  const [editing, setEditing] = useState(!review);
  const [decision, setDecision] = useState<StoryDecision | "">(review?.decision ?? "");
  const [code, setCode] = useState(review?.reason_code ?? "");
  const [category, setCategory] = useState(review?.category ?? section ?? "");
  const [note, setNote] = useState(review?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const other = STORY_OTHER_CODES.includes(code);
  const needsCategory = Boolean(decision) && CATEGORY_REQUIRED_FOR.has(decision);

  async function save(next: { decision: StoryDecision | null; reason_code: string | null; reason: string | null; category: string | null }) {
    setBusy(true); setError("");
    try {
      const saved = await adminApi<NonNullable<StoryReviewValue>>(`runs/${encodeURIComponent(runId)}/story-reviews`, { method: "POST", body: JSON.stringify({ item_id: itemId, ...next }) });
      const value = next.decision ? saved : null;
      onSaved?.(value);
      setEditing(!value);
      if (!value) { setDecision(""); setCode(""); setNote(""); setCategory(section ?? ""); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  if (review && !editing) return <div className="story-review">
    <span className={`status-badge tone-${review.decision === "accept" ? "ok" : "failed"}`}>{review.decision === "accept" ? "Accepted" : "Rejected"}</span>
    <small> {review.reason_code} {review.reason_label}{review.category ? ` · ${categoryLabel(review.category)}` : ""}{review.reason ? `: ${review.reason}` : ""} · {review.by}</small>
    <div><button type="button" className="run-inspect-link" onClick={() => setEditing(true)}>Change</button></div>
  </div>;

  return <div className="story-review">
    <select aria-label="Decision" value={decision} disabled={busy} onChange={(event) => { setDecision(event.target.value as StoryDecision | ""); setCode(""); }}>
      <option value="">Decision…</option><option value="accept">Accept</option><option value="reject">Reject</option>
    </select>
    {decision && <select aria-label="Reason" value={code} disabled={busy} onChange={(event) => setCode(event.target.value)}>
      <option value="">Reason…</option>{STORY_REASONS[decision].map((reason) => <option key={reason.code} value={reason.code}>{reason.code} {reason.label}</option>)}
    </select>}
    {decision && <select aria-label="Category" value={category} disabled={busy} onChange={(event) => setCategory(event.target.value)}>
      <option value="">{needsCategory ? "Category (required)…" : "Category (optional)…"}</option>
      {SECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select>}
    {decision && <input aria-label="Note" value={note} maxLength={1000} disabled={busy} placeholder={other ? "Explain (required)" : "Note (optional)"} onChange={(event) => setNote(event.target.value)} />}
    {decision && <button type="button" className="secondary" disabled={busy || !code || (other && !note.trim()) || (needsCategory && !category)}
      onClick={() => void save({ decision, reason_code: code, reason: note.trim() || null, category: category || null })}>Save</button>}
    {review && <button type="button" className="run-inspect-link" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>}
    {review && <button type="button" className="run-inspect-link" disabled={busy} onClick={() => void save({ decision: null, reason_code: null, reason: null, category: null })}>Clear</button>}
    {error && <p className="alert" role="alert">{error}</p>}
  </div>;
}
