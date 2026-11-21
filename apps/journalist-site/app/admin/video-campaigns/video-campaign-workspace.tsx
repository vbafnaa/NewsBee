"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CampaignCopy, publicCampaign } from "@/pipeline/campaigns/video-campaigns";

type Campaign = ReturnType<typeof publicCampaign>;
type Workspace = {
  campaigns: Campaign[]; configured: boolean; unavailableReason: string | null;
  fundingSource: string | null; model: string;
};
const empty: CampaignCopy = { title: "", brief: "", script: "", caption: "", prompt: "" };
const endpoint = "/api/admin/video-campaigns";
const fields = [
  ["brief", "Campaign brief", 4000, "Audience, objective, verified claims and call to action. Internal context, not sent to the video provider."],
  ["script", "Exact spoken script", 1200, "Write a short script that fits 15 seconds (roughly 30 words). Only use claims you can substantiate."],
  ["caption", "Social caption", 2200, "Saved for manual use alongside the download; not burned into the video or posted."],
  ["prompt", "Visual direction", 6000, "Describe the scene, style and movement. Avoid unlicensed brands and implied endorsements."],
] as const;

async function responseJson(response: Response) {
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail ?? "Campaign request failed.");
  return result;
}

export default function VideoCampaignWorkspace() {
  const [data, setData] = useState<Workspace | null>(null);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [copy, setCopy] = useState<CampaignCopy>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const dirty = !selected || Object.keys(empty).some((key) => copy[key as keyof CampaignCopy] !== selected[key as keyof CampaignCopy]);

  async function reload() {
    setError("");
    try {
      const loaded: Workspace = await responseJson(await fetch(endpoint, { cache: "no-store" }));
      setData(loaded);
      setSelected((current) => current ? loaded.campaigns.find((campaign) => campaign._id === current._id) ?? null : null);
      setConfirmed(false);
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load campaigns."); }
  }
  useEffect(() => { void reload(); }, []);

  function choose(campaign: Campaign | null) {
    if (dirty && Object.values(copy).some(Boolean) && !window.confirm("Discard unsaved campaign edits?")) return;
    setSelected(campaign);
    setCopy(campaign ? { title: campaign.title, brief: campaign.brief, script: campaign.script, caption: campaign.caption, prompt: campaign.prompt } : empty);
    setConfirmed(false);
    setMessage("");
    setError("");
  }

  async function action(kind: "save" | "render" | "refresh") {
    setBusy(true); setError(""); setMessage("");
    try {
      const { campaign }: { campaign: Campaign } = await responseJson(await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: kind, id: selected?._id, revision: selected?.revision, copy, confirmPaid: confirmed }),
      }));
      setSelected(campaign);
      setConfirmed(false);
      setData((current) => current ? { ...current, campaigns: [campaign, ...current.campaigns.filter((item) => item._id !== campaign._id)].slice(0, 50) } : current);
      if (kind === "save") {
        setCopy({ title: campaign.title, brief: campaign.brief, script: campaign.script, caption: campaign.caption, prompt: campaign.prompt });
        setMessage("Draft saved. No provider request was made.");
      } else setMessage(kind === "render" ? "Video attempt recorded. Use Refresh status to check the same attempt." : "Video status updated.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Campaign action failed.");
    } finally { setBusy(false); }
  }

  const render = selected?.render;
  const active = render && !["complete", "failed"].includes(render.status);
  return <>
    <p>Promotional videos from your own copy. Nothing is rendered, posted or emailed on navigation or save. <Link href="/admin/campaigns">Campaign requests</Link> are reviewed separately.</p>
    {error && <p className="alert" role="alert">{error} <button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>Reload campaign list</button></p>}
    {message && <p role="status">{message}</p>}
    {!data ? <p role="status">{error ? "Campaign workspace unavailable." : "Loading campaigns..."}</p> : <>
      <section className="panel">
        <h2>Your campaigns</h2>
        <p>Latest 50 drafts. Other operators cannot read or change your campaigns.</p>
        <label>Open a campaign
          <select value={selected?._id ?? ""} disabled={busy} onChange={(event) => choose(data.campaigns.find((campaign) => campaign._id === event.target.value) ?? null)}>
            <option value="">New campaign</option>
            {data.campaigns.map((campaign) => <option value={campaign._id} key={campaign._id}>{campaign.title} · {campaign.render?.status ?? "draft"}</option>)}
          </select>
        </label>
      </section>
      <section className="panel">
        <h2>{selected ? "Edit campaign" : "Create campaign"}</h2>
        <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void action("save"); }}>
          <label>Campaign name<input required maxLength={160} value={copy.title} disabled={busy} onChange={(event) => setCopy({ ...copy, title: event.target.value })} /></label>
          {fields.map(([key, label, maxLength, help]) => <label key={key}>{label}
            <textarea rows={4} maxLength={maxLength} value={copy[key]} disabled={busy} onChange={(event) => { setCopy({ ...copy, [key]: event.target.value }); setConfirmed(false); }} />
            <small>{help}</small>
          </label>)}
          <div><button disabled={busy || !copy.title.trim()} type="submit">{busy ? "Working..." : "Save draft"}</button></div>
        </form>
      </section>
      <section className="panel">
        <h2>Review and create video</h2>
        <p>fal.ai · {data.model} · 15 seconds · vertical 9:16 MP4. Funding: {data.fundingSource === "environment" ? "Owner-authorized environment credentials" : "your personal credentials (Owner accounts may inherit authorized environment defaults)"}. Managed newsroom funding is never used.</p>
        <p>The provider sets the price; Newsbee cannot quote it here. Check your fal.ai account pricing and balance before confirming. One deliberate submission may incur a charge, even if it fails or is interrupted.</p>
        {!data.configured && <p className="alert">{data.unavailableReason} <Link href="/account">Configure API keys</Link></p>}
        {dirty && <p>Save and review your latest copy before rendering.</p>}
        {active && <p>An attempt is active. Refresh it below; another paid submission is blocked.</p>}
        {render?.downloadable && <p>Download the current MP4 before starting another attempt; this workspace keeps only the latest result.</p>}
        <label><input type="checkbox" checked={confirmed} disabled={busy || Boolean(active) || dirty} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the saved script and visual direction, have rights to this content, and authorize one paid fal.ai video request.</label>
        <button type="button" disabled={busy || !selected || dirty || !data.configured || !confirmed || Boolean(active) || !copy.brief || !copy.script || !copy.prompt}
          onClick={() => void action("render")}>{render ? "Create another paid video" : "Create paid video"}</button>
      </section>
      {render && <section className="panel" aria-live="polite">
        <h2>Latest video: {render.status}</h2>
        <p>Attempt {render.id} · {new Date(render.createdAt).toLocaleString()}</p>
        {render.error && <p className="alert" role="alert">{render.error}</p>}
        {active && <button type="button" disabled={busy} onClick={() => void action("refresh")}>Refresh status</button>}
        {render.downloadable && <a className="button" href={`${endpoint}?download=${encodeURIComponent(selected!._id)}`}>Download MP4</a>}
        <details><summary>Copy used for this video</summary>
          <h3>Spoken script</h3><p style={{ whiteSpace: "pre-wrap" }}>{render.script}</p>
          <h3>Caption for manual posting</h3><p style={{ whiteSpace: "pre-wrap" }}>{render.caption || "No caption saved."}</p>
          <h3>Provider prompt</h3><p style={{ whiteSpace: "pre-wrap" }}>{render.prompt}</p>
        </details>
        <p>No YouTube upload, social posting or email is performed.</p>
      </section>}
    </>}
  </>;
}
