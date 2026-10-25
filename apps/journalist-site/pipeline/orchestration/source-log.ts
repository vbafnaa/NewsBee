/**
 * Readable source tables in the server log (Vercel Logs, or the terminal locally), next to
 * the JSON log records. Every source is printed: when a location's sources are found, when a
 * run starts, as each source finishes, and once more when collection is complete.
 */
import type { LocationProfile, SourceResult, SourceTask, SourceType } from "../connectors/types";
import { SECTIONS, sectionOf } from "../../../../shared/newsletter-layout";

/** The reader category each source type mainly feeds. */
export const SOURCE_CATEGORIES: Record<SourceType, string> = {
  library: "Events / Library",
  civiccalendar: "Events / City & parks calendars",
  meetings: "Council / Public meetings",
  statenews: "Top News / Community & state newsrooms",
  trending: "Top News / Community reporting",
  hazards: "Public Safety / Earthquakes",
  homesafety: "Public Safety / Drinking water",
  housing: "Real Estate & Development / Housing",
  development: "Real Estate & Development / Permits",
  athletics: "Schools / Athletics",
};

export function sourceCategory(type: string) {
  return SOURCE_CATEGORIES[type as SourceType] ?? `Other / ${type}`;
}

/** Collected item counts by reader tab, e.g. "Events 30, Council 4". */
export function itemsBySection(kinds: Array<string | undefined>) {
  const counts = new Map<string, number>();
  for (const kind of kinds) {
    const label = SECTIONS.find((section) => section.id === sectionOf(kind))!.label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join(", ") || "none";
}

/** A fixed-width text table; long cells are shortened so each row stays on one line. */
export function textTable(headers: string[], rows: string[][], maxWidth = 70) {
  const cell = (value: string) => (value.length > maxWidth ? `${value.slice(0, maxWidth - 1)}…` : value);
  const cells = [headers, ...rows].map((row) => row.map((value) => cell(String(value ?? ""))));
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => row[column]?.length ?? 0)));
  const line = (row: string[]) => row.map((value, column) => value.padEnd(widths[column])).join(" | ").trimEnd();
  return [line(cells[0]), widths.map((width) => "-".repeat(width)).join("-+-"), ...cells.slice(1).map(line)].join("\n");
}

function print(title: string, body: string) {
  console.log(`\n=== Newsbee sources: ${title} ===\n${body}\n`);
}

/** Sources a location will run, printed when it is onboarded or re-checked. */
export function logLocationSources(location: LocationProfile, tasks: SourceTask[]) {
  const rows = tasks.map((task, index) => [String(index + 1), sourceCategory(task.type), task.name, task.type, task.source_id]);
  const branches = location.systems.flatMap((system) => system.branches.map((branch) => `${branch.name} (${system.name})`));
  const government = location.government;
  const details = [
    `Library branches: ${branches.join("; ") || "none found"}`,
    `Meetings: ${government?.platform ? `${government.platform} ${government.tenant ?? ""}`.trim() : "none found"}${government?.detail ? ` - ${government.detail}` : ""}`,
    `Newsroom feeds: ${location.community?.newsrooms.map((room) => `${room.name} <${room.feed}>`).join("; ") || "none found"}`,
    `Coverage terms: ${location.community?.coverage_terms.join(", ") || location.name}`,
    `Gaps: ${[...(location.source_coverage?.gaps ?? []), ...(location.source_coverage?.discovery_gaps ?? [])].join("; ") || "none"}`,
  ];
  print(`${location.name} (${location.id}), ${tasks.length} sources found`, `${textTable(["#", "Category", "Source", "Type", "Id"], rows)}\n${details.join("\n")}`);
}

/** Sources queued for a run, printed when it starts. */
export function logRunSources(location: LocationProfile, runId: string, tasks: SourceTask[]) {
  const rows = tasks.map((task, index) => [String(index + 1), sourceCategory(task.type), task.name, task.params?.manual_link_id ? "manual link" : task.type, task.source_id]);
  print(`run ${runId} for ${location.name}, ${tasks.length} sources queued`, textTable(["#", "Category", "Source", "Type", "Id"], rows));
}

/** One line as each source finishes collecting. */
export function logSourceCollected(locationName: string, task: SourceTask, result: SourceResult, kinds: Array<string | undefined>, listed: number) {
  const parts = [
    locationName, sourceCategory(task.type), task.name, result.status,
    `${kinds.length} items (${itemsBySection(kinds)}), ${listed} published as listings`,
    result.feed_url ?? result.website ?? "", result.detail ?? "",
  ].filter(Boolean);
  console.log(`[newsbee:source] ${parts.join(" | ")}`);
}

/** Every source with its outcome, printed once collection is complete. */
export function logCollectionSummary(locationName: string, runId: string, rows: Array<{ task: SourceTask; result: SourceResult | undefined; items: number; listed: number; sections: string }>) {
  const table = textTable(
    ["Category", "Source", "Status", "Items", "Listings", "By section", "Feed or site"],
    rows.map(({ task, result, items, listed, sections }) => [sourceCategory(task.type), task.name, result?.status ?? "not collected", String(items), String(listed), sections, result?.feed_url ?? result?.website ?? ""]),
  );
  const items = rows.reduce((sum, row) => sum + row.items, 0);
  const listed = rows.reduce((sum, row) => sum + row.listed, 0);
  print(`run ${runId} for ${locationName} collected, ${items} items, ${listed} listings`, table);
}
