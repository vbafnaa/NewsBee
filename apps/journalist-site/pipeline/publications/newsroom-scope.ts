/**
 * Which communities a signed-in person may review from the journalist workspace.
 *
 * Operators (owners and admins) keep their global reach; naming a newsroom only narrows what
 * they see. Journalists must name a newsroom they belong to, and only that newsroom's covered
 * communities are in scope. Anything outside the scope reads as not found, so a journalist
 * cannot probe other newsrooms' communities.
 */
import type { Db, Filter } from "mongodb";
import { isOperator, type Principal } from "../accounts/identity";
import { COLLECTIONS } from "../storage/mongo";
import { publicationAccessFilter, type PublicationRecord } from "./access";

export class NewsroomScopeDenied extends Error {}
export class NewsroomScopeNotFound extends Error {}

export type LocationScope = {
  /** True for owners and admins. */
  operator: boolean;
  /** The newsroom the request was made from, if any. */
  publicationId: string | null;
  /** The communities in scope; null means every community (operators without a newsroom). */
  locationIds: string[] | null;
};

type NewsroomRecord = PublicationRecord & { archived_at?: number | null };

export async function resolveLocationScope(db: Db, principal: Principal, publicationId?: string | null): Promise<LocationScope> {
  const newsrooms = db.collection<NewsroomRecord>(COLLECTIONS.outputChannels);
  const id = publicationId?.trim() || null;
  if (isOperator(principal)) {
    if (!id) return { operator: true, publicationId: null, locationIds: null };
    const newsroom = await newsrooms.findOne({ _id: id }, { projection: { selected_location_ids: 1 } });
    if (!newsroom) throw new NewsroomScopeNotFound("Newsroom not found.");
    return { operator: true, publicationId: id, locationIds: newsroom.selected_location_ids ?? [] };
  }
  if (!id) throw new NewsroomScopeDenied("Open this from a newsroom you're assigned to.");
  const newsroom = await newsrooms.findOne({
    _id: id,
    archived_at: { $not: { $type: "number" } },
    ...publicationAccessFilter<NewsroomRecord>(principal.id),
  } as Filter<NewsroomRecord>, { projection: { selected_location_ids: 1 } });
  if (!newsroom) throw new NewsroomScopeNotFound("Newsroom not found.");
  return { operator: false, publicationId: id, locationIds: newsroom.selected_location_ids ?? [] };
}

export function locationInScope(scope: LocationScope, locationId: string | null | undefined) {
  return scope.locationIds === null || Boolean(locationId && scope.locationIds.includes(locationId));
}

/** Throws not-found for a community outside the scope. */
export function assertLocationInScope(scope: LocationScope, locationId: string | null | undefined, what = "Item") {
  if (!locationInScope(scope, locationId)) throw new NewsroomScopeNotFound(`${what} not found for this newsroom.`);
}

/** The location filter to apply to a list: one requested community (checked), or every community in scope. */
export function scopedLocationFilter(scope: LocationScope, requested?: string | null): string | string[] | undefined {
  if (requested) {
    assertLocationInScope(scope, requested, "Community");
    return requested;
  }
  return scope.locationIds ?? undefined;
}
