"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { adminApi } from "@/lib/admin-client";
import type { photoSupplyOpportunities } from "@/pipeline/images/opportunities";
import type { PhotoCatalogSource, PhotoScope } from "../../../../../shared/photo-catalog";
import type { StoryImage } from "../../../../../shared/story-image";
import styles from "../../photo-supply/photo-supply.module.css";

type Opportunities = ReturnType<typeof photoSupplyOpportunities>;
type Inbox = { invites: { id: string; source: PhotoCatalogSource; status: string; expires_at: string }[];
  submissions: { _id: string; name: string; email: string; status: string; submitted_at: string; photos: StoryImage[]; grant_text: string }[];
  sources: PhotoCatalogSource[]; opportunities: Opportunities };
type Draft = { id: string; name: string; kind: PhotoScope["kind"]; scope_name: string; city: string; urls: string; domains: string;
  identity_url: string; evidence_url: string; contact_email: string; event_date: string; photos: Partial<StoryImage>[] };
const empty = (): Draft => ({ id: "", name: "", kind: "story", scope_name: "", city: "", urls: "", domains: "", identity_url: "",
  evidence_url: "", contact_email: "", event_date: "", photos: [] });
const lines = (value: string) => value.split(/[\n,]+/).map(line => line.trim()).filter(Boolean);

export default function PhotoSupplyManager({ locationId }: { locationId: string }) {
  const [inbox, setInbox] = useState<Inbox | null>(null), [draft, setDraft] = useState<Draft>(empty);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [link, setLink] = useState(""), [requestText, setRequestText] = useState(""), [rejectReason, setRejectReason] = useState("");
  const path = `locations/${encodeURIComponent(locationId)}/photo-supply`;
  const refresh = useCallback(async () => setInbox(await adminApi<Inbox>(path)), [path]);
  useEffect(() => { refresh().catch((cause: Error) => setError(cause.message)); }, [refresh]);
  const change = (field: keyof Draft, value: string) => setDraft(current => ({ ...current, [field]: value }));
  async function action(action: string, id: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      await adminApi(path, { method: "POST", body: JSON.stringify({ action, id, reason: rejectReason }) });
      setMessage(action === "approve" ? "Permission approved. The image pipeline still checks relevance, resolution, crop and duplicates before publication."
        : action === "revoke_source" ? "Photo grant withdrawn. Existing catalog references are now withheld."
        : action === "revoke_invite" ? "Invitation disabled. Existing approved grants are unchanged." : "Submission rejected.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update photo supply."); }
    finally { setBusy(false); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setLink("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await adminApi<{ token: string; expires_at: string }>(path, { method: "POST", body: JSON.stringify({ action: "create_invite",
        expires_on: form.get("expires_on"), contact_email: draft.contact_email, requested_photos: draft.photos,
        source: { id: draft.id, name: draft.name, evidence_url: draft.evidence_url,
          scope: { kind: draft.kind, name: draft.scope_name, city: draft.city, aliases: [], source_urls: lines(draft.urls),
            source_domains: lines(draft.domains), identity_url: draft.identity_url, event_date: draft.event_date } } }) });
      const url = `${window.location.origin}/photo-supply/${result.token}`;
      setLink(url);
      setRequestText(`Hello,\n\nNewsbee would like to use recent photographs of ${draft.scope_name} for our community coverage in ${draft.city}. Could you provide original files, actual capture dates, photographer credits and factual captions? Please confirm that you can grant editorial publication, archived edition use and resizing/cropping at no charge. We will review each photograph for relevance and quality. We use a photograph at most once in an edition.\n\nYou can review the exact coverage, expiry and permission, and submit up to six photographs at a time here:\n${url}\n\nThis invitation expires ${new Date(result.expires_at).toLocaleDateString()}. Submitting a file does not publish it. If a photographer or another rights holder must approve, please refer us to them.\n\nThank you,\nNewsbee`);
      setMessage("Invitation prepared. Copy the request below to contact the rights holder. Nothing has been sent.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the invitation."); }
    finally { setBusy(false); }
  }
  function prepare(candidate: Opportunities["candidates"][number], start = 0) {
    setLink(""); setRequestText(""); setMessage("");
    setDraft({ ...empty(), id: `${candidate.id}-${start + 1}`, name: candidate.name, kind: candidate.kind, scope_name: candidate.scope_name,
      city: candidate.city, urls: candidate.source_urls.join("\n"), evidence_url: candidate.source_url, identity_url: candidate.identity_url,
      contact_email: candidate.contact_email, photos: candidate.photos.slice(start, start + 6) });
  }
  return <section id="photo-supply" className="panel"><h2>Photo supply</h2>
    <p>Request originals and permission from publishers or organizers. Approved grants join the catalog; the image pipeline decides whether each photograph fits a story.</p>
    {error && <p role="alert" className={styles.notice}>{error}</p>}
    {message && <p role="status" className={styles.status}>{message}</p>}
    {!inbox ? <p>Loading photo supply…</p> : <div className={styles.form}>
      {!!inbox.opportunities.candidates.length && <div className={styles.card}><h3>Researched photo candidates</h3><p>Checked {inbox.opportunities.checked_on}. These files still need permission and verified capture dates.</p>
        {inbox.opportunities.candidates.map(candidate => <div key={candidate.id} className={styles.card}><h3>{candidate.name}</h3>
          <p>{candidate.photos.length} candidates · <a href={candidate.source_url} target="_blank" rel="noreferrer">Original source</a></p>
          {candidate.kind === "person" && <p>Add the actual coverage article URLs to the request before creating the invitation.</p>}
          <div className={styles.actions}>{Array.from({ length: Math.ceil(candidate.photos.length / 6) }, (_, batch) =>
            <button key={batch} type="button" onClick={() => prepare(candidate, batch * 6)}>Prepare request{candidate.photos.length > 6 ? ` ${batch + 1}` : ""}</button>)}</div>
        </div>)}
      </div>}
      {!!inbox.opportunities.suppliers.length && <details className={styles.card}><summary>Recurring organizer and media leads</summary>
        {inbox.opportunities.suppliers.map(supplier => <div key={supplier.id}><a href={supplier.source_url} target="_blank" rel="noreferrer">{supplier.id}</a>
          {"contact" in supplier && <p>{supplier.contact}</p>}<p>{supplier.request}</p></div>)}
      </details>}
      <details className={styles.card} open={!!draft.name}><summary>Create a photo invitation</summary>
        <form className={styles.form} onSubmit={create}>
          <div className={styles.grid}>
            <label className="field">Source ID<input value={draft.id} pattern="[a-z0-9][a-z0-9_-]*" maxLength={60} onChange={e => change("id", e.target.value)} required /></label>
            <label className="field">Source name<input value={draft.name} maxLength={240} onChange={e => change("name", e.target.value)} required /></label>
            <label className="field">Coverage scope<select value={draft.kind} onChange={e => change("kind", e.target.value)}>{["story", "event", "venue", "street", "person", "organization"].map(kind => <option key={kind}>{kind}</option>)}</select></label>
            <label className="field">Specific subject or place<input value={draft.scope_name} onChange={e => change("scope_name", e.target.value)} required /></label>
            <label className="field">City<input value={draft.city} onChange={e => change("city", e.target.value)} required /></label>
            <label className="field">Grant expires<input type="date" name="expires_on" defaultValue={new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)} required /></label>
            <label className={`field ${styles.full}`}>Exact coverage article URLs, one per line<textarea value={draft.urls} onChange={e => change("urls", e.target.value)} required={draft.kind === "story"} /></label>
            {(draft.kind === "person" || draft.kind === "organization") && <>
              <label className="field">Identity evidence page<input type="url" value={draft.identity_url} onChange={e => change("identity_url", e.target.value)} required /></label>
              <label className="field">Approved publisher domains, if no article URL<input value={draft.domains} onChange={e => change("domains", e.target.value)} placeholder="publisher.example" /></label>
            </>}
            {draft.kind === "event" && <label className="field">Actual event date<input type="date" value={draft.event_date} onChange={e => change("event_date", e.target.value)} required /></label>}
            <label className={`field ${styles.full}`}>Public source or rights evidence page<input type="url" value={draft.evidence_url} onChange={e => change("evidence_url", e.target.value)} required /></label>
            <label className={`field ${styles.full}`}>Contact email, if verified<input type="email" value={draft.contact_email} onChange={e => change("contact_email", e.target.value)} /></label>
          </div>
          {!!draft.photos.length && <p>{draft.photos.length} researched files will be suggested. The supplier must confirm or correct every credit, caption and capture date.</p>}
          <button type="submit" disabled={busy}>Create invitation and request draft</button>
        </form>
      </details>
      {link && <div className={styles.card}><h3>Request ready to share</h3><p>The link is shown only now and expires after 14 days. You can revoke it below. Use a public deployment address if the recipient cannot reach localhost.</p>
        <a className={styles.wrap} href={link} target="_blank" rel="noreferrer">Open photo invitation</a>
        <label className="field">Unsent request<textarea rows={12} readOnly value={requestText} /></label>
        <div className={styles.actions}><button type="button" onClick={() => navigator.clipboard.writeText(requestText).catch(() => setError("Select and copy the request text manually."))}>Copy request</button>
          {draft.contact_email && <a href={`mailto:${encodeURIComponent(draft.contact_email)}?subject=${encodeURIComponent("Newsbee photo permission request")}&body=${encodeURIComponent(requestText)}`}>Open email draft</a>}</div>
      </div>}
      <h3>Submissions awaiting review</h3>
      {!inbox.submissions.some(item => item.status === "pending") && <p>No submissions awaiting review.</p>}
      {inbox.submissions.filter(item => item.status === "pending").map(item => <article className={styles.card} key={item._id}>
        <h3>{item.name}</h3><p>{item.email} · {item.submitted_at.slice(0, 10)}</p>
        <ul>{item.photos.map(photo => <li key={photo.image}><a href={photo.image} target="_blank" rel="noreferrer">{photo.image_caption}</a> — {photo.image_credit}, taken {photo.image_date}</li>)}</ul>
        <p>{item.grant_text}</p><label className="field">Reason if rejecting<input value={rejectReason} onChange={e => setRejectReason(e.target.value)} maxLength={600} /></label>
        <div className={styles.actions}><button disabled={busy} onClick={() => action("approve", item._id)}>Approve photo grant</button><button disabled={busy} onClick={() => action("reject", item._id)}>Reject submission</button></div>
      </article>)}
      <details className={styles.card}><summary>Invitations and approved sources</summary><p>Revoking an invitation stops new submissions. Withdraw a photo grant separately to withhold previously approved files.</p>
        {inbox.invites.filter(invite => invite.status === "active").map(invite => <div key={invite.id} className={styles.actions}><span>{invite.source.name} · link expires {new Date(invite.expires_at).toLocaleDateString()}</span><button disabled={busy} onClick={() => action("revoke_invite", invite.id)}>Revoke invitation</button></div>)}
        {inbox.sources.filter(source => source.status === "active").map(source => <div key={source.id} className={styles.actions}><span>{source.name} · grant expires {source.expires_on}</span><button disabled={busy} onClick={() => action("revoke_source", source.id)}>Withdraw photo grant</button></div>)}
      </details>
    </div>}
  </section>;
}
