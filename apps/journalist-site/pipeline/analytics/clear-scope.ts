/** What a reader-data clear covers. Free of database imports so the admin page can share it. */
export const ALL_LOCATIONS_CONFIRMATION = "all locations";

export type ClearScope = { location_id: string | null };
export type ClearCounts = { impressions: number; clicks: number; shares: number; interest_records: number; interest_marks: number };
export type KeptCounts = { subscriptions: number; legacy_signups: number };
export type ClearLocation = ClearCounts & KeptCounts & { id: string; name: string };
export type ClearRecord = {
  id: string; by: string; at: string; finished_at: string | null; status: "started" | "completed" | "failed";
  scope: "all" | "location"; location_id: string | null; location_name: string | null;
  deleted: ClearCounts; error: string | null;
};
export type ClearPreview = { totals: ClearCounts & KeptCounts; locations: ClearLocation[]; recent: ClearRecord[] };

export const clearedTotal = (counts: ClearCounts) =>
  counts.impressions + counts.clicks + counts.shares + counts.interest_records + counts.interest_marks;

/** Reads an admin's request. Scope must be explicit so a malformed body can never mean "everything". */
export function parseClearRequest(body: unknown): ClearScope {
  const { scope, location_id, confirm } = (body ?? {}) as Record<string, unknown>;
  let parsed: ClearScope;
  if (scope === "all") parsed = { location_id: null };
  else if (scope === "location" && typeof location_id === "string" && location_id.trim()) parsed = { location_id };
  else throw new Error('Invalid scope: use "all" or "location" with a location_id.');
  if (confirm !== (parsed.location_id ?? ALL_LOCATIONS_CONFIRMATION)) throw new Error("Invalid confirmation: it must match the selected scope.");
  return parsed;
}
