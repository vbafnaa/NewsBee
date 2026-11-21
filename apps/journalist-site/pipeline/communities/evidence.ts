import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { boundary, withinArea } from "../../../../shared/geography";
import type { Principal } from "../accounts/identity";
import type { LocationProfile } from "../connectors/types";
import { COLLECTIONS } from "../storage/mongo";
import { getLocation, LocationBusy } from "./locations";
import { systemsForPlace, systemsInArea } from "./directory";
import { sourceCoverage, sourceEvidenceByLocation } from "./source-coverage";

type EvidenceEvent = {
  id: string; revision: number; at: string; by: string; reason: string; provenance_url: string;
  before: ReturnType<typeof evidenceSnapshot>; after: ReturnType<typeof evidenceSnapshot>;
};
type EvidenceDocument = LocationProfile & { _id: string; evidence_events?: EvidenceEvent[] };

function evidenceSnapshot(profile: LocationProfile) {
  const area = profile.community?.geography?.area;
  return {
    area_method: area?.method ?? null,
    boundary_sha256: area?.boundary ? createHash("sha256").update(JSON.stringify(area.boundary)).digest("hex") : null,
    outlets: profile.systems.map((system) => ({ system_id: system.fscskey,
      outlet_ids: system.branches.map((branch) => branch.directory_outlet_id ?? branch.name) })),
  };
}

export async function locationEvidenceCandidates(db: Db, profile: LocationProfile) {
  const geography = profile.community?.geography;
  if (geography && geography.area.method !== "boundary") return { systems: [], edition: null };
  return geography ? systemsInArea(db, geography) : systemsForPlace(db, profile.community?.parent_id ?? profile.id);
}

export async function repairLocationEvidence(db: Db, id: string, input: {
  revision: unknown; reason: unknown; provenance_url: unknown; boundary?: unknown; outlet_ids?: unknown;
}, actor: Principal) {
  if (!["owner", "admin"].includes(actor.role)) throw new Error("Invalid evidence repair: operator access is required");
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0
    || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500) {
    throw new Error("Invalid evidence repair: send the current revision and a reason of 1-500 characters");
  }
  let url: URL;
  try { url = new URL(String(input.provenance_url)); } catch { throw new Error("Invalid evidence repair: provide the evidence HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.toString().length > 2000) {
    throw new Error("Invalid evidence repair: provide a public HTTPS provenance URL without credentials");
  }
  if (input.boundary === undefined && input.outlet_ids === undefined) throw new Error("Invalid evidence repair: select boundary evidence or directory outlets");
  const collection = db.collection<EvidenceDocument>(COLLECTIONS.locations);
  const stored = await collection.findOne({ _id: id });
  if (!stored) throw new Error(`Location is not onboarded: ${id}`);
  const profile = await getLocation(db, id);
  if ((stored.evidence_revision ?? 0) !== input.revision) throw new LocationBusy("Location evidence changed; reload before saving");
  if (input.boundary !== undefined) {
    const shape = boundary(input.boundary);
    if (!shape || JSON.stringify(shape).length > 500_000) throw new Error("Invalid evidence repair: provide a bounded Polygon or MultiPolygon geometry, not a bounding box or radius");
    const polygons = shape.type === "Polygon" ? [shape.coordinates] : shape.coordinates;
    if (polygons.some((rings) => rings.some((ring) => Math.abs(ring.slice(0, -1).reduce((sum, p, i) =>
      sum + p[0] * ring[i + 1][1] - ring[i + 1][0] * p[1], 0)) < 1e-10))) {
      throw new Error("Invalid evidence repair: boundary rings must enclose an area");
    }
    const geography = profile.community?.geography;
    if (!geography) throw new Error("Invalid evidence repair: this location has no geographic identity to repair");
    const area = { method: "boundary" as const, boundary: shape };
    if (!withinArea(area, [geography.longitude, geography.latitude], [geography.longitude, geography.latitude])) {
      throw new Error("Invalid evidence repair: boundary must contain the location's recorded point");
    }
    profile.community = { ...profile.community!, geography: { ...geography, area } };
  }
  const candidates = await locationEvidenceCandidates(db, profile);
  if (input.outlet_ids !== undefined) {
    if (!Array.isArray(input.outlet_ids) || !input.outlet_ids.length || input.outlet_ids.length > 200
      || input.outlet_ids.some((value) => typeof value !== "string")) {
      throw new Error("Invalid evidence repair: select 1-200 actual directory outlets");
    }
    const ids = new Set<string>(input.outlet_ids);
    const available = new Set(candidates.systems.flatMap((system) => system.branches.map((branch) => branch.directory_outlet_id)));
    if ([...ids].some((value) => !available.has(value))) throw new Error("Invalid evidence repair: an outlet is missing from the directory or outside the actual boundary");
    profile.systems = candidates.systems.map((system) => ({
      ...system,
      branches: system.branches.filter((branch) => branch.directory_outlet_id && ids.has(branch.directory_outlet_id)),
      website: stored.systems.find((old) => old.fscskey === system.fscskey)?.website ?? null,
      website_lookup: stored.systems.find((old) => old.fscskey === system.fscskey)?.website_lookup,
    })).filter((system) => system.branches.length);
    profile.directory_edition = `IMLS PLS ${candidates.edition}`;
  } else if (input.boundary !== undefined) {
    // A changed boundary cannot retain unverified/out-of-area branch associations.
    const available = new Set(candidates.systems.flatMap((system) => system.branches.map((branch) => branch.directory_outlet_id)));
    profile.systems = profile.systems.map((system) => ({ ...system,
      branches: system.branches.filter((branch) => branch.directory_outlet_id && available.has(branch.directory_outlet_id)),
    })).filter((system) => system.branches.length);
  }
  if (profile.community) profile.community.library_branches = profile.systems.flatMap((system) => system.branches.map((branch) => branch.name));
  const at = new Date().toISOString();
  const revision = Number(input.revision) + 1;
  const provenance = { url: url.toString(), reason: input.reason.trim(), at, by: actor.id };
  const evidence = (await sourceEvidenceByLocation(db, [id])).get(id) ?? [];
  const coverage = sourceCoverage(profile, profile.source_coverage?.discovery_gaps, [], evidence);
  const event: EvidenceEvent = { id: randomUUID(), revision, at, by: actor.id, reason: provenance.reason,
    provenance_url: provenance.url, before: evidenceSnapshot(stored), after: evidenceSnapshot(profile) };
  const result = await collection.updateOne({
    _id: id, removal: { $exists: false },
    ...(stored.evidence_revision === undefined ? { evidence_revision: { $exists: false } } : { evidence_revision: stored.evidence_revision }),
    systems: stored.systems,
    ...(stored.community ? { community: stored.community } : { community: { $exists: false } }),
  }, {
    $set: { systems: profile.systems, ...(profile.community ? { community: profile.community } : {}),
      directory_edition: profile.directory_edition, source_coverage: coverage, evidence_revision: revision, evidence_provenance: provenance,
      ...(input.boundary !== undefined ? { boundary_provenance: provenance } : {}) },
    $push: { evidence_events: { $each: [event], $slice: -50 } },
  });
  if (!result.matchedCount) throw new LocationBusy("Location evidence changed; reload before saving");
  return getLocation(db, id);
}
