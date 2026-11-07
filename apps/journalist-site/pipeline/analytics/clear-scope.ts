/** What a reader-data clear covers. Free of database imports so the admin page can share it. */
export const ALL_LOCATIONS_CONFIRMATION = "all locations";

export const CLEAR_DATA_TYPES = ["impressions", "clicks", "shares", "interest", "subscriptions", "legacy_signups"] as const;
export type ClearDataType = typeof CLEAR_DATA_TYPES[number];
export const DEFAULT_CLEAR_DATA_TYPES: ClearDataType[] = ["impressions", "clicks", "shares"];
export const LEGACY_CLEAR_DATA_TYPES: ClearDataType[] = [...DEFAULT_CLEAR_DATA_TYPES, "interest"];
export type ClearScope = { location_id: string | null; data_types: ClearDataType[] };
export type ClearCounts = { impressions: number; clicks: number; shares: number; interest_records: number; interest_marks: number; subscriptions: number; legacy_signups: number };
export type ClearLocation = ClearCounts & { id: string; name: string };
export type ClearRecord = {
  id: string; by: string; at: string; finished_at: string | null; status: "started" | "completed" | "failed";
  scope: "all" | "location"; location_id: string | null; location_name: string | null;
  data_types: ClearDataType[]; deleted: ClearCounts; error: string | null;
};
export type ClearPreview = { totals: ClearCounts; locations: ClearLocation[]; recent: ClearRecord[] };

export const clearTypeCount = (counts: ClearCounts, type: ClearDataType) =>
  type === "interest" ? counts.interest_records + counts.interest_marks : counts[type];
export const clearedTotal = (counts: ClearCounts, types: readonly ClearDataType[] = CLEAR_DATA_TYPES) =>
  types.reduce((total, type) => total + clearTypeCount(counts, type), 0);

export function parseClearDataTypes(value: unknown): ClearDataType[] {
  if (!Array.isArray(value) || !value.length || value.some((type) => !CLEAR_DATA_TYPES.includes(type)) || new Set(value).size !== value.length) {
    throw new Error("Invalid data types: explicitly select one or more supported reader-data categories.");
  }
  return CLEAR_DATA_TYPES.filter((type) => value.includes(type));
}

/** Reads an admin's request. Scope must be explicit so a malformed body can never mean "everything". */
export function parseClearRequest(body: unknown): ClearScope {
  const { scope, location_id, confirm, data_types } = (body ?? {}) as Record<string, unknown>;
  let parsed: Pick<ClearScope, "location_id">;
  if (scope === "all") parsed = { location_id: null };
  else if (scope === "location" && typeof location_id === "string" && location_id.trim()) parsed = { location_id };
  else throw new Error('Invalid scope: use "all" or "location" with a location_id.');
  if (confirm !== (parsed.location_id ?? ALL_LOCATIONS_CONFIRMATION)) throw new Error("Invalid confirmation: it must match the selected scope.");
  return { ...parsed, data_types: parseClearDataTypes(data_types) };
}
