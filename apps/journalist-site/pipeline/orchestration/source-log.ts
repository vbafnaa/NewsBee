/**
 * Readable source tables in the server log (Vercel Logs, or the terminal locally), next to
 * the JSON log records. Every source is printed with its newsletter section: as each
 * discovery method finds sources, when a run plans its sources from the source map, and as
 * each source finishes collecting.
 */
import type { SourceResult, SourceTask } from "../connectors/types";
import { METHOD_LABELS, type DiscoveryMethod, type SourceCandidate } from "../sourcemap/store";
import { SECTIONS, sectionLabel } from "../sourcemap/sections";
import type { RunSourceSnapshot } from "./runs";

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

/** In newsletter section order, then by name. */
function bySection<T extends { section: string; name: string }>(sources: T[]) {
  const order = (section: string) => { const index = SECTIONS.findIndex((entry) => entry.id === section); return index < 0 ? SECTIONS.length : index; };
  return [...sources].sort((a, b) => order(a.section) - order(b.section) || a.name.localeCompare(b.name));
}

/** "Events and things to do 12, Schools and youth 4". */
export function sectionCounts(sources: Array<{ section: string }>) {
  const counts = new Map<string, number>(SECTIONS.map((section) => [section.label, 0]));
  for (const source of sources) counts.set(sectionLabel(source.section), (counts.get(sectionLabel(source.section)) ?? 0) + 1);
  return [...counts].filter(([, count]) => count).map(([label, count]) => `${label} ${count}`).join(", ") || "none";
}

function methodLabel(method: string) {
  return METHOD_LABELS[method as DiscoveryMethod] ?? method;
}

/** Every source one discovery method found for a location. */
export function logDiscoveredSources(locationName: string, label: string, candidates: SourceCandidate[], added: number) {
  const rows = bySection(candidates).map((candidate, index) => [String(index + 1), sectionLabel(candidate.section), candidate.name, candidate.reader, candidate.url ?? candidate.feed_url ?? "", candidate.found_by.detail]);
  const table = rows.length ? textTable(["#", "Section", "Source", "Reader", "URL", "How it was found"], rows) : "No sources found";
  print(`${locationName}: ${label}, ${candidates.length} found, ${added} new on the map`, `${table}\nBy section: ${sectionCounts(candidates)}`);
}

/** Every source on the location's map when a run plans its collection, read or not. */
export function logSourceMap(locationName: string, runId: string, sources: RunSourceSnapshot[]) {
  const rows = bySection(sources).map((source, index) => [
    String(index + 1), sectionLabel(source.section), source.name, methodLabel(source.found_by), source.reader,
    source.collected ? "reading" : `not read: ${source.skip_reason ?? source.status}`, source.url ?? "",
  ]);
  const reading = sources.filter((source) => source.collected);
  const table = rows.length ? textTable(["#", "Section", "Source", "Found by", "Reader", "This run", "URL"], rows) : "The source map is empty";
  print(`run ${runId} for ${locationName}, ${reading.length} of ${sources.length} sources on the map read`, `${table}\nReading by section: ${sectionCounts(reading)}`);
}

/** One line as each source finishes collecting. */
export function logSourceCollected(locationName: string, section: string | null, task: SourceTask, result: SourceResult, kept: number, leftOut: number) {
  const parts = [
    locationName, sectionLabel(section), task.name, result.status, `${kept} items kept, ${leftOut} left out`,
    result.feed_url ?? result.website ?? "", result.detail ?? "",
  ].filter(Boolean);
  console.log(`[newsbee:source] ${parts.join(" | ")}`);
}
