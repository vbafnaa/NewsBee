/** What a source-data clear covers. Free of database imports so the admin page can share it. */
export const SOURCE_CLEAR_TYPES = ["discovered", "editor_added", "reviews", "page_decisions", "gemini_checks", "test_runs", "settings", "discovery_history", "cached_discovery", "saved_addresses", "source_health"] as const;
export type SourceClearType = typeof SOURCE_CLEAR_TYPES[number];
export type SourceClearCounts = Record<SourceClearType, number>;
export type SourceClearLocation = SourceClearCounts & { id: string; name: string; active_run: boolean };
export type SourceClearRecord = {
  id: string; by: string; at: string; finished_at: string | null; status: "started" | "completed" | "failed";
  scope: "all" | "location"; location_id: string | null; location_name: string | null;
  data_types: SourceClearType[]; deleted: SourceClearCounts; error: string | null;
};
export type SourceClearPreview = { totals: SourceClearCounts; locations: SourceClearLocation[]; active_runs: number; recent: SourceClearRecord[] };

export const NO_SOURCE_DATA: SourceClearCounts = { discovered: 0, editor_added: 0, reviews: 0, page_decisions: 0, gemini_checks: 0, test_runs: 0, settings: 0, discovery_history: 0, cached_discovery: 0, saved_addresses: 0, source_health: 0 };

/** Sources people added: an editor's link, an approved reader suggestion, or a link from before the source map. */
export const EDITOR_METHODS = ["editor", "reader_suggestion", "migrated"];

export function parseSourceClearTypes(value: unknown): SourceClearType[] {
  if (!Array.isArray(value) || !value.length || value.some((type) => !SOURCE_CLEAR_TYPES.includes(type)) || new Set(value).size !== value.length) {
    throw new Error("Invalid data types: explicitly select one or more source-data categories.");
  }
  return SOURCE_CLEAR_TYPES.filter((type) => value.includes(type));
}

export const sourceClearTotal = (counts: SourceClearCounts, types: readonly SourceClearType[] = SOURCE_CLEAR_TYPES) =>
  types.reduce((total, type) => total + counts[type], 0);
