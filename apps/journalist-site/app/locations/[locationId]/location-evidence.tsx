"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-client";
import type { LocationProfile, LibrarySystem } from "@/pipeline/connectors/types";

type Data = { location: LocationProfile; evidence_candidates: { systems: LibrarySystem[]; edition: string | null } };

export default function LocationEvidence({ locationId }: { locationId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [geometry, setGeometry] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const path = `locations/${encodeURIComponent(locationId)}`;
  const load = useCallback(async () => {
    const result = await adminApi<Data>(path);
    setData(result);
    const available = new Set(result.evidence_candidates.systems.flatMap((system) => system.branches.map((branch) => branch.directory_outlet_id)));
    setSelected(result.location.systems.flatMap((system) => system.branches.flatMap((branch) =>
      branch.directory_outlet_id && available.has(branch.directory_outlet_id) ? [branch.directory_outlet_id] : [])));
  }, [path]);
  useEffect(() => { void load().catch((cause) => setError(String(cause))); }, [load]);
  async function save(kind: "boundary" | "outlets") {
    if (!data) return;
    setBusy(true); setError(""); setNotice("");
    try {
      let shape: unknown;
      if (kind === "boundary") {
        try { shape = JSON.parse(geometry); } catch { throw new Error("Provide valid GeoJSON Polygon or MultiPolygon geometry."); }
      }
      await adminApi(path, { method: "PATCH", body: JSON.stringify({
        revision: data.location.evidence_revision ?? 0, reason, provenance_url: url,
        ...(kind === "boundary" ? { boundary: shape } : { outlet_ids: selected }),
      }) });
      await load();
      setGeometry(""); setReason(""); setUrl("");
      setNotice("Optional evidence saved. Readiness uses current usable source-map links and the preparation state.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const profile = data?.location;
  return <section className="panel location-evidence" id="location-evidence">
    <h2>Location evidence and diagnostics</h2>
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!data && !error && <p role="status">Loading evidence...</p>}
    {profile && <>
      <p>Current usable source-map links are enough to mark this location Ready. Geography, library associations and category coverage are optional diagnostics, not readiness requirements. Source access rules and explicit preparation blocks still apply.</p>
      <p>{profile.community?.geography?.area.method === "boundary" ? "Actual boundary recorded." : profile.community?.geography ? "An approximate area is not a boundary." : "Reviewed place directory coverage."} Evidence revision {profile.evidence_revision ?? 0}.</p>
      {profile.evidence_provenance && <p className="chart-caption">Last repair: <a href={profile.evidence_provenance.url} target="_blank" rel="noopener noreferrer">provenance</a> · {profile.evidence_provenance.reason} · {new Date(profile.evidence_provenance.at).toLocaleString()}</p>}
      {profile.boundary_provenance && <p className="chart-caption">Boundary: <a href={profile.boundary_provenance.url} target="_blank" rel="noopener noreferrer">original evidence</a> · {profile.boundary_provenance.reason}</p>}
      {profile.source_coverage?.gaps.length ? <ul aria-label="Optional coverage diagnostics">{profile.source_coverage.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul> : <p>No source-coverage gaps recorded. Mark Ready in the readiness queue after reviewing usable source-map links.</p>}
      <p><Link href={`/locations/${encodeURIComponent(locationId)}?tab=sources`}>Review sources and labels</Link> · <Link href="/admin#location-requests">Review readiness queue</Link></p>
      <label className="field">Evidence provenance URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://authoritative-source.example/boundary" maxLength={2000} /></label>
      <label className="field">Repair reason<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} /></label>
      {profile.community?.geography && <details>
        <summary>Record actual boundary evidence</summary>
        <p>Use a verified Polygon or MultiPolygon geometry from the cited source. Do not convert an approximate box or radius into a boundary. Saving clears branch associations that cannot be verified against the new boundary; reselect actual directory outlets below.</p>
        <label className="field">GeoJSON geometry<textarea rows={8} value={geometry} onChange={(event) => setGeometry(event.target.value)} maxLength={500000} /></label>
        <button type="button" disabled={busy || !geometry.trim() || !reason.trim() || !url.trim()} onClick={() => void save("boundary")}>Save boundary evidence</button>
      </details>}
      <details>
        <summary>Associate actual library directory outlets</summary>
        <p>Only canonical outlets inside the actual boundary are available. No out-of-boundary service branches or invented outlets qualify. New systems may need a validated website or readable library source afterward.</p>
        {data!.evidence_candidates.systems.map((system) => <fieldset key={system.fscskey}><legend>{system.name}</legend>
          {system.branches.map((branch) => <label className="field" key={branch.directory_outlet_id}>
            <span><input type="checkbox" checked={selected.includes(branch.directory_outlet_id!)} onChange={(event) => setSelected((current) =>
              event.target.checked ? [...current, branch.directory_outlet_id!] : current.filter((id) => id !== branch.directory_outlet_id))} /> {branch.name} - {branch.address}</span>
          </label>)}
        </fieldset>)}
        {!data!.evidence_candidates.systems.length && <p className="notice">No eligible directory outlets. Actual boundary evidence may help identify qualifying branches for optional library sources. This does not block location readiness.</p>}
        <button type="button" disabled={busy || !selected.length || !reason.trim() || !url.trim()} onClick={() => void save("outlets")}>Save directory associations</button>
      </details>
    </>}
  </section>;
}
