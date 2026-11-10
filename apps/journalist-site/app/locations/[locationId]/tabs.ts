/** A location's publishing workflow. */
export const LOCATION_TABS = [
  ["overview", "Overview"], ["sources", "Sources"], ["collect-sources", "Collect sources"], ["edition", "Collect stories"],
  ["published", "Publish"], ["settings", "Settings"],
] as const;

/** Older tab names still open the workspace tab that now holds their content. */
export const MOVED_TABS: Record<string, string> = { review: "edition", runs: "collect-sources", editions: "published", map: "published" };
