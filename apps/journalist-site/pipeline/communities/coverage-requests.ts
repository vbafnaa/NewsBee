import type { Db } from "mongodb";
import { assertPublicationWrite, authorizedPublicationFilter, type PublicationContext, type PublicationRecord } from "../publications/access";
import { PublicationAccessDenied } from "../publications/permissions";
import { COLLECTIONS } from "../storage/mongo";
import { locationReadinessForIds } from "./readiness";

export const COVERAGE_REQUESTS = "publication_coverage_requests";
type CoverageRequest = {
  _id: string; publication_id: string; publication_name: string; location_id: string | null;
  requested_at: string; requested_by: string;
};
export type CoverageRequestStatus = { status: "requested" | "preparing" | "blocked" | "ready"; requested_at: string };

async function currentPublication(db: Db, context: PublicationContext) {
  const publication = await db.collection<PublicationRecord>(COLLECTIONS.outputChannels).findOne(authorizedPublicationFilter(context));
  if (!publication) throw new PublicationAccessDenied();
  return publication;
}

export async function publicationCoverageRequests(db: Db, context: PublicationContext) {
  const publication = await currentPublication(db, context);
  const allowed = publication.allowed_location_ids ?? publication.selected_location_ids ?? [];
  const requests = await db.collection<CoverageRequest>(COVERAGE_REQUESTS).find({ publication_id: context.id }).toArray();
  const locations = await locationReadinessForIds(db, allowed.map((id) => ({ id, name: id })));
  const request = requests.find((entry) => entry.location_id === null);
  return {
    locations: locations.map((row) => {
      const request = requests.find((entry) => entry.location_id === row.location_id);
      return { ...row, request: request ? { status: row.state === "ready" ? "ready" : row.state === "blocked" ? "blocked" : row.onboarded ? "preparing" : "requested",
        requested_at: request.requested_at } satisfies CoverageRequestStatus : null };
    }),
    request: request ? { status: locations.some((row) => row.ready) ? "ready" : allowed.length ? "preparing" : "requested",
      requested_at: request.requested_at } satisfies CoverageRequestStatus : null,
    request_href: `/api/admin/publications/${encodeURIComponent(context.id)}/coverage-requests`,
  };
}

export async function requestPublicationCoverage(db: Db, context: PublicationContext, locationId: unknown) {
  await assertPublicationWrite(db, context, "Request newsroom coverage preparation");
  const publication = await currentPublication(db, context);
  const allowed = publication.allowed_location_ids ?? publication.selected_location_ids ?? [];
  if (locationId !== null && (typeof locationId !== "string" || !allowed.includes(locationId))) {
    throw new Error("Invalid coverage request: choose an allowed location; requests never expand coverage");
  }
  if (locationId === null && allowed.length) throw new Error("Invalid coverage request: choose the allowed location that needs preparation");
  const _id = JSON.stringify([context.id, locationId]);
  await db.collection(COVERAGE_REQUESTS).createIndex({ publication_id: 1, location_id: 1 }, { name: "publication_coverage_request_scope" });
  // The deterministic identity makes a lost response and concurrent retry the same request.
  await db.collection<CoverageRequest>(COVERAGE_REQUESTS).updateOne({ _id }, { $setOnInsert: {
    publication_id: context.id, publication_name: publication.name, location_id: locationId,
    requested_at: new Date().toISOString(), requested_by: context.principalId,
  } }, { upsert: true });
  return publicationCoverageRequests(db, context);
}

export async function coverageOperationsRequests(db: Db, locationIds?: string[]) {
  const requests = await db.collection<CoverageRequest>(COVERAGE_REQUESTS)
    .find(locationIds ? { location_id: { $in: locationIds } } : {}).sort({ requested_at: -1 }).toArray();
  const publications = await db.collection<PublicationRecord>(COLLECTIONS.outputChannels)
    .find({ _id: { $in: [...new Set(requests.map((request) => request.publication_id))] } }).toArray();
  return requests.filter((request) => {
    const publication = publications.find((publication) => publication._id === request.publication_id);
    if (!publication) return false;
    const allowed = publication.allowed_location_ids ?? publication.selected_location_ids ?? [];
    return request.location_id === null ? !allowed.length : allowed.includes(request.location_id);
  });
}
