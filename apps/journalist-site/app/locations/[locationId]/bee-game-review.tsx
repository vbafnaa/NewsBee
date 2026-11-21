"use client";

import { useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import type { BeeGame } from "@/pipeline/games/save-the-bee";

type Review = {
  game: BeeGame;
  previous: { previousGameId?: string; finalized: boolean; candidates: Array<{ attemptId: string; nickname: string; score: number }> };
};
export default function BeeGameReview({ locationId, editionId, onReady }: {
  locationId: string; editionId: string; onReady: (ready: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Review | null>(null);
  const [word, setWord] = useState("");
  const [clue, setClue] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `locations/${encodeURIComponent(locationId)}/editions/${encodeURIComponent(editionId)}/game`;
  const frozen = data && ["frozen", "published"].includes(data.game.status);
  function apply(next: Review) {
    setData(next); setWord(next.game.word); setClue(next.game.clue);
    setSelected(next.game.shoutouts.map(a => a.attemptId)); setDirty(false);
    onReady(["approved", "frozen", "published"].includes(next.game.status));
  }
  useEffect(() => {
    if (!open) return;
    setError("");
    let active = true;
    adminApi<Review>(path).then(next => { if (active) apply(next); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [open, path]);
  async function action(action: "save" | "regenerate" | "approve" | "close-previous") {
    if (!data) return;
    if (action === "close-previous" && !window.confirm("Finalize the previous results? This cannot be undone.")) return;
    setBusy(true); setError("");
    try {
      apply(await adminApi<Review>(path, { method: "POST", body: JSON.stringify({
        action, revision: data.game.revision, word, clue, shoutoutIds: selected,
      }) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const changed = () => { setDirty(true); onReady(false); };
  const winners = frozen ? data.game.shoutouts : data?.previous.candidates ?? [];
  return <details id={`bee-review-${editionId}`} className="bee-editor" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Guide the Bee Home {frozen ? <small>Published</small> : data?.game.status === "approved" && !dirty ? <small>Approved</small> : null}</summary>
    {open && <>
      {error && <p className="alert" role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading...</p>}
      {data && <>
        <div className="bee-editor-fields">
          <label>Word<input aria-label="Game word" value={word} maxLength={12} disabled={Boolean(frozen) || busy} onChange={event => { setWord(event.target.value.toUpperCase()); changed(); }} /></label>
          <label>Clue<input aria-label="Game clue" value={clue} maxLength={180} disabled={Boolean(frozen) || busy} onChange={event => { setClue(event.target.value); changed(); }} /></label>
        </div>
        {(winners.length > 0 || (!frozen && data.previous.previousGameId && !data.previous.finalized)) && <details className="bee-editor-winners">
          <summary>Last week's shout-outs{selected.length > 0 ? ` (${selected.length})` : ""}</summary>
          {!frozen && !data.previous.finalized && <button disabled={busy} onClick={() => void action("close-previous")}>Review previous results</button>}
          {winners.map(candidate => <label className="checkbox-label" key={candidate.attemptId}>
            <input type="checkbox" checked={selected.includes(candidate.attemptId)} disabled={Boolean(frozen) || busy}
              onChange={event => { setSelected(event.target.checked ? [...selected, candidate.attemptId] : selected.filter(id => id !== candidate.attemptId)); changed(); }} />
            {candidate.nickname} · {candidate.score}
          </label>)}
        </details>}
        {!frozen && <div className="card-actions">
            <button disabled={busy} onClick={() => void action("regenerate")}>New word</button>
            <button disabled={busy} onClick={() => void action("save")}>Update</button>
            <button disabled={busy} aria-label="Approve word, clue and selected shout-outs" onClick={() => void action("approve")}>Approve</button>
          </div>
        }
      </>}
    </>}
  </details>;
}
