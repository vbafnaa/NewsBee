"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiJson } from "@/lib/admin-client";
import { PHOTO_SUPPLY_MAX_PHOTOS, type PublicPhotoInvite } from "../../../../../shared/photo-supply";
import type { StoryImage } from "../../../../../shared/story-image";
import styles from "../photo-supply.module.css";

const blank = (): Partial<StoryImage> => ({ image: "", image_source_url: "", image_credit: "", image_caption: "", image_date: "" });
const permissions = [
  ["authority", "I own these photos or have authority to grant their use."],
  ["no_charge", "I grant the use described above at no charge."],
  ["people_permissions", "I have obtained any required permissions from people depicted."],
  ["editorial", "Newsbee may publish these files for the stated editorial coverage."],
  ["archive", "Newsbee may retain them in archived editions within the stated expiry."],
  ["crop", "Newsbee may resize and crop these photographs for its layouts."],
] as const;

export default function PhotoSupplyForm({ token }: { token: string }) {
  const [invite, setInvite] = useState<PublicPhotoInvite | null>(null), [photos, setPhotos] = useState<Partial<StoryImage>[]>([blank()]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false);
  const requestId = useRef("");
  const path = `/api/photo-supply/${token}`;
  useEffect(() => {
    let active = true;
    apiJson<PublicPhotoInvite>(path).then(data => {
      if (active) { setInvite(data); setPhotos(data.requested_photos.length ? data.requested_photos : [blank()]); }
    }).catch((cause: Error) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [path]);
  function change(index: number, field: keyof StoryImage, value: string) {
    setPhotos(items => items.map((photo, at) => at === index ? { ...photo, [field]: value } : photo));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    requestId.current ||= crypto.randomUUID();
    setBusy(true); setError("");
    try {
      await apiJson(path, { method: "POST", body: JSON.stringify({ request_id: requestId.current, name: form.get("name"), email: form.get("email"), photos,
        ...Object.fromEntries(permissions.map(([key]) => [key, form.get(key) === "on"])) }) });
      setSubmitted(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not submit the photographs."); }
    finally { setBusy(false); }
  }
  if (submitted) return <section className="panel" role="status"><h2>Thank you for sharing</h2><p>Your photographs and permission are awaiting editorial review. We will check the files, story relevance and layout before use.</p></section>;
  return <>
    {error && <p role="alert" className={styles.notice}>{error}</p>}
    {!invite ? !error && <p role="status">Loading invitation…</p> : <form className={styles.form} onSubmit={submit}>
      <section className="panel"><h2>{invite.name}</h2><p>For {invite.location_name}: {invite.scope.kind} coverage of <strong>{invite.scope.name}</strong>, {invite.scope.city}. Permission expires {invite.expires_on}.</p>
        {invite.scope.event_date && <p>Event date: {invite.scope.event_date}</p>}
        {invite.scope.source_urls.length > 0 && <ul>{invite.scope.source_urls.map(url => <li key={url}><a className={styles.wrap} href={url} target="_blank" rel="noreferrer">Coverage source</a></li>)}</ul>}
        {!!invite.scope.source_domains?.length && <p>Coverage publishers: {invite.scope.source_domains.join(", ")}</p>}
        <p className={styles.status}>{invite.grant_text}</p>
      </section>
      <div className={styles.grid}><label className="field">Your name<input name="name" autoComplete="name" maxLength={120} required /></label>
        <label className="field">Your email<input name="email" type="email" autoComplete="email" maxLength={254} required /></label></div>
      <p>Link to original photographs you host publicly. Include the actual capture date and photographer credit. Please provide files at least 1,200 pixels wide; lead images need 1,800 pixels. Your contact details remain internal.</p>
      {photos.map((photo, index) => <fieldset key={index} className={styles.card} disabled={busy}><legend>Photograph {index + 1}</legend>
        <div className={styles.grid}>
          <label className={`field ${styles.full}`}>Original image URL<input type="url" value={photo.image} onChange={e => change(index, "image", e.target.value)} required /></label>
          <label className={`field ${styles.full}`}>Public source or photo page<input type="url" value={photo.image_source_url} onChange={e => change(index, "image_source_url", e.target.value)} required /></label>
          <label className="field">Capture date<input type="date" value={photo.image_date} onChange={e => change(index, "image_date", e.target.value)} required /></label>
          <label className="field">Photographer credit<input value={photo.image_credit} maxLength={240} onChange={e => change(index, "image_credit", e.target.value)} required /></label>
          <label className={`field ${styles.full}`}>Factual caption<input value={photo.image_caption} maxLength={500} onChange={e => change(index, "image_caption", e.target.value)} required /></label>
        </div>
        {photos.length > 1 && <button type="button" onClick={() => setPhotos(items => items.filter((_, at) => at !== index))}>Remove photograph</button>}
      </fieldset>)}
      {photos.length < PHOTO_SUPPLY_MAX_PHOTOS && <button type="button" disabled={busy} onClick={() => setPhotos(items => [...items, blank()])}>Add another photograph</button>}
      <fieldset className={styles.card} disabled={busy}><legend>Confirm permission</legend>
        {permissions.map(([key, label]) => <label className={styles.check} key={key}><input type="checkbox" name={key} required /><span>{label}</span></label>)}
      </fieldset>
      <div className={styles.actions}><button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit for review"}</button><small>Submission does not publish your photographs.</small></div>
    </form>}
  </>;
}
