import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import {
  calculateLocationReadiness,
  type LocationPreparation,
  type LocationReadiness,
  type StoredLocationPreparationState,
} from "../../../../shared/location-readiness";
export type { StoredLocationPreparationState } from "../../../../shared/location-readiness";
import type { Principal } from "../accounts/identity";
import type { LocationProfile } from "../connectors/types";
import { COLLECTIONS } from "../storage/mongo";
import { LocationBusy } from "./locations";
import { sourceCoverage, sourceEvidenceByLocation } from "./source-coverage";
import { coverageOperationsRequests } from "./coverage-requests";

const SIGNUPS = "reader_interest_signups";
const EDITIONS = "editions";

type PreparationEvent = {
  id: string;
  from: LocationReadiness["state"];
  to: StoredLocationPreparationState;
  at: string;
  by: string;
  by_email: string;
  reason: string | null;
  prerequisites: string[];
};

export type ReadinessLocationDocument = LocationProfile & {
  _id: string;
  preparation?: LocationPreparation;
  preparation_events?: PreparationEvent[];
};

export type LocationDemand = {
  location_id: string;
  location_name: string;
  request_count: number;
  last_requested_at: Date | null;
};

export type LocationReadinessRow = LocationReadiness & {
  location_id: string;
  location_name: string;
  demand: number;
  last_requested_at: string | null;
  preparation: LocationPreparation | null;
  source_coverage: LocationProfile["source_coverage"] | null;
  source_map_at: number | null;
  active_source_count: number;
  onboarded: boolean;
  published: boolean;
  remedy?: { href: string; label: string };
  newsroom_request_count?: number;
};

export async function ensureLocationReadinessIndexes(db: Db) {
  await Promise.all([
    db.collection(COLLECTIONS.locations).createIndex(
      { "preparation.state": 1, "preparation.updated_at": -1 },
      { name: "location_preparation_state_updated" },
    ),
    db.collection(SIGNUPS).createIndex(
      { interest_signup_at: 1, location_id: 1 },
      { name: "location_interest_demand" },
    ),
  ]);
}

export async function locationDemand(db: Db, locationIds?: string[]): Promise<LocationDemand[]> {
  return db.collection(SIGNUPS).aggregate<LocationDemand>([
    { $match: {
      interest_signup_at: { $type: "date" },
      ...(locationIds ? { location_id: { $in: locationIds } } : {}),
    } },
    { $group: {
      _id: "$location_id",
      location_name: { $max: "$location_name" },
      request_count: { $sum: 1 },
      last_requested_at: { $max: "$interest_signup_at" },
    } },
    { $project: {
      _id: 0,
      location_id: "$_id",
      location_name: { $ifNull: ["$location_name", "$_id"] },
      request_count: 1,
      last_requested_at: 1,
    } },
    { $sort: { request_count: -1, last_requested_at: -1, location_id: 1 } },
  ]).toArray();
}

async function readinessRows(
  db: Db,
  candidates: Array<{ id: string; name: string }>,
  profiles?: ReadinessLocationDocument[],
  demands?: LocationDemand[],
): Promise<LocationReadinessRow[]> {
  if (!candidates.length) return [];
  const ids = [...new Set(candidates.map((candidate) => candidate.id))];
  const locationDocuments = profiles ?? await db.collection<ReadinessLocationDocument>(COLLECTIONS.locations)
    .find({ _id: { $in: ids } }).toArray();
  const profileById = new Map(locationDocuments.map((profile) => [profile._id, profile]));
  const [demandRows, publishedIds, evidenceById, coverageRequests] = await Promise.all([
    demands ?? locationDemand(db, ids),
    db.collection(EDITIONS).distinct("location_id", { location_id: { $in: ids }, status: "published" }),
    sourceEvidenceByLocation(db, ids),
    coverageOperationsRequests(db, ids),
  ]);
  const demandById = new Map(demandRows.map((row) => [row.location_id, row]));
  const published = new Set(publishedIds.map(String));

  return candidates.map(({ id, name }) => {
    const profile = profileById.get(id);
    const demand = demandById.get(id);
    const evidence = evidenceById.get(id) ?? [];
    const coverage = profile ? sourceCoverage(profile, profile.source_coverage?.discovery_gaps, [], evidence) : undefined;
    const activeSourceCount = evidence.length;
    const newsroomRequestCount = coverageRequests.filter((request) => request.location_id === id).length;
    const result = calculateLocationReadiness({
      onboarded: Boolean(profile),
      demand: (demand?.request_count ?? 0) + newsroomRequestCount,
      preparation: profile?.preparation,
      source_map_at: profile?.source_map_at,
      source_coverage: coverage,
      active_source_count: activeSourceCount,
      published: published.has(id),
    });
    return {
      ...result,
      newsroom_request_count: newsroomRequestCount,
      remedy: { href: `/locations/${encodeURIComponent(id)}?tab=settings#location-evidence`, label: "Review location evidence and sources" },
      location_id: id,
      location_name: profile?.name ?? demand?.location_name ?? name,
      demand: demand?.request_count ?? 0,
      last_requested_at: demand?.last_requested_at?.toISOString() ?? null,
      preparation: profile?.preparation ?? null,
      source_coverage: coverage ?? null,
      source_map_at: profile?.source_map_at ?? null,
      active_source_count: activeSourceCount,
      onboarded: Boolean(profile),
      published: published.has(id),
    };
  });
}

export async function locationReadinessForIds(db: Db, candidates: Array<{ id: string; name: string }>) {
  return readinessRows(db, candidates);
}

export async function locationReadinessCatalog(db: Db, loadedProfiles?: LocationProfile[]): Promise<LocationReadinessRow[]> {
  await ensureLocationReadinessIndexes(db);
  const [profiles, demands, requests] = await Promise.all([
    loadedProfiles
      ? Promise.resolve(loadedProfiles.map((profile) => ({ ...profile, _id: profile.id }) as ReadinessLocationDocument))
      : db.collection<ReadinessLocationDocument>(COLLECTIONS.locations).find({}).sort({ name: 1, _id: 1 }).toArray(),
    locationDemand(db),
    coverageOperationsRequests(db),
  ]);
  const byId = new Map<string, { id: string; name: string }>();
  for (const profile of profiles) byId.set(profile._id, { id: profile._id, name: profile.name });
  for (const demand of demands) if (!byId.has(demand.location_id)) byId.set(demand.location_id, { id: demand.location_id, name: demand.location_name });
  for (const request of requests) if (request.location_id && !byId.has(request.location_id)) byId.set(request.location_id, { id: request.location_id, name: request.location_id });
  return readinessRows(db, [...byId.values()], profiles, demands);
}

export async function transitionLocationReadiness(
  db: Db,
  locationId: string,
  to: StoredLocationPreparationState,
  actor: Principal,
  reason?: string | null,
) {
  if (!["preparing", "ready", "blocked"].includes(to)) throw new Error("Invalid readiness state");
  const note = reason?.trim() || null;
  if (note && note.length > 500) throw new Error("Invalid readiness transition: reason is too long");
  if (to === "blocked" && !note) throw new Error("Invalid readiness transition: a blocking reason is required");
  await ensureLocationReadinessIndexes(db);
  const profile = await db.collection<ReadinessLocationDocument>(COLLECTIONS.locations).findOne({ _id: locationId });
  if (!profile) throw new Error(`Location is not onboarded: ${locationId}`);
  const [current] = await readinessRows(db, [{ id: locationId, name: profile.name }], [profile]);
  if (current.state === "blocked" && to !== "blocked" && !note) throw new Error("Invalid readiness transition: a resume reason is required");
  if (to === "ready" && !current.can_mark_ready) {
    throw new Error(`Invalid readiness transition: ${current.missing_prerequisites.join(" ")}`);
  }
  const at = new Date().toISOString();
  const preparation: LocationPreparation = {
    state: to,
    updated_at: at,
    updated_by: actor.id,
    updated_by_email: actor.email,
    reason: note,
  };
  const event: PreparationEvent = {
    id: randomUUID(),
    from: current.state,
    to,
    at,
    by: actor.id,
    by_email: actor.email,
    reason: note,
    prerequisites: current.missing_prerequisites,
  };
  const saved = await db.collection<ReadinessLocationDocument>(COLLECTIONS.locations).updateOne(
    {
      _id: locationId,
      ...(profile.preparation
        ? {
          "preparation.state": profile.preparation.state,
          "preparation.updated_at": profile.preparation.updated_at,
        }
        : { preparation: { $exists: false } }),
    },
    {
      $set: { preparation },
      $push: { preparation_events: { $each: [event], $slice: -50 } },
    },
  );
  if (!saved.matchedCount) throw new LocationBusy(`Location readiness changed while updating ${locationId}; reload and try again`);
  const [updated] = await readinessRows(db, [{ id: locationId, name: profile.name }], [{ ...profile, preparation }]);
  return updated;
}
