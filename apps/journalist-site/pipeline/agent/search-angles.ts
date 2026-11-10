/**
 * Search angles, for an exhaustive run. Three rewordings of one idea reach the same pages, so a
 * cell's misses only mean something when they are different ideas. Every search declares an angle
 * family (the twelve in playbook/general.yaml), and code holds the agent to them:
 *
 *   anchor      the first angle in every category: the place and the category's main term. Code
 *               writes its query, so every tool runs the same one.
 *   sequence    after the anchor the agent picks the category's next angle, with a short reason.
 *               The sequence is per category and shared by every tool: a cell runs the angles it
 *               hasn't caught up on, in order, before it may pick a new one.
 *   refusals    a family the cell has already tried; a query too close to an earlier one in the
 *               same cell (token overlap, threshold in the playbook); a Roles query that names a
 *               person instead of a title; a tool-native query that doesn't use what the tool has.
 *   dry         a cell that has tried every family that applies to it is dry (../search-grid.ts).
 *
 * No server imports, so the Source runs page and the agent read the same rules.
 */
import type { PriorityTopic } from "../core/run-values";
import { limit, list, ruleSet } from "../playbook";
import { SEARCH_TOOLS, cellKey, searchOutcomes, type CellSearch, type GridSource, type SearchTool } from "./search-grid";

export const ANGLE_FAMILIES = ["anchor", "geography", "institutions", "publisher", "format", "item_type", "time", "language", "directories", "roles", "more_like_this", "tool_native"] as const;
export type AngleFamily = typeof ANGLE_FAMILIES[number];

const FAMILY_TEXT = Object.fromEntries(ruleSet("angle_families").map((rule) => [rule.id.replace(/^general\.search\.angle_/, ""), rule.text!])) as Record<AngleFamily, string>;
for (const family of ANGLE_FAMILIES) if (!FAMILY_TEXT[family]) throw new Error(`The playbook has no angle family ${family}`);
/** Each family's name, as the playbook writes it before its question. */
export const ANGLE_LABELS = Object.fromEntries(ANGLE_FAMILIES.map((family) => [family, FAMILY_TEXT[family].split(":")[0].replace(/\s*\(.*\)$/, "")])) as Record<AngleFamily, string>;

export type Vocabulary = { anchor: string; terms: string[]; roles: string[] };
export const VOCABULARY = Object.fromEntries(ruleSet("angle_vocabulary").map((rule) => {
  const map = rule.map as { topic: string; anchor: string; roles?: string[] };
  return [map.topic, { anchor: map.anchor, terms: rule.values ?? [], roles: map.roles ?? [] }];
})) as Record<PriorityTopic, Vocabulary>;
const ROLE_WORDS = list("general.search.angle_role_words");
/** Share of words two queries in one cell may have in common before the second is a near-duplicate. */
export const QUERY_OVERLAP = limit("general.stop.agent_query_overlap");
/** Fewest words in Exa's tool-native description. */
export const NATIVE_WORDS = limit("general.stop.agent_native_words");

/** One angle in a category's sequence, shared by every tool: who picked it, when and why. */
export type AngleStep = { family: AngleFamily; reason: string; step: number; at: number; tool: SearchTool };
export type AngleSequences = Partial<Record<string, AngleStep[]>>;
/** What decides whether a family applies to a cell: an accepted source to find more like, and whether Tavily can still explore. */
export type AngleContext = { accepted: boolean; explore: boolean };

/** Why a family doesn't apply to a cell, or null when it does. */
export function notApplicable(family: AngleFamily, tool: SearchTool, context: AngleContext) {
  if (family === "more_like_this" && !context.accepted) return "nothing is accepted for this category yet, so there is nothing to find more like";
  if (family === "tool_native" && tool === "tavily" && !context.explore) return "Tavily's tool-native angle is explore, which isn't available now";
  return null;
}
export const applicableFamilies = (tool: SearchTool, context: AngleContext) => ANGLE_FAMILIES.filter((family) => !notApplicable(family, tool, context));

/** The families that apply to every cell, by `category|tool`, for the grid's dry rule. */
export function applicableCells(topics: PriorityTopic[], tools: readonly SearchTool[], context: (category: PriorityTopic) => AngleContext) {
  return Object.fromEntries(topics.flatMap((category) => tools.map((tool) => [cellKey(category, tool), applicableFamilies(tool, context(category))]))) as Record<string, string[]>;
}

const inCell = (searches: CellSearch[], category: string, tool: SearchTool) => searches.filter((search) => search.category === category && search.tool === tool).sort((a, b) => a.step - b.step);
export const triedAngles = (searches: CellSearch[], category: string, tool: SearchTool) => inCell(searches, category, tool).flatMap((search) => search.angle ? [search.angle] : []);
export const cellQueries = (searches: CellSearch[], category: string, tool: SearchTool) => inCell(searches, category, tool).flatMap((search) => search.query ? [search.query] : []);

/** The angle a cell has to run next: the first in its category's sequence it hasn't tried and that applies to it. Null when it may pick a new one. */
export function pendingAngle(sequence: AngleStep[], tried: string[], applicable: string[]) {
  return sequence.find((angle) => !tried.includes(angle.family) && applicable.includes(angle.family)) ?? null;
}

export type AngleCheck = { ok: true; family: AngleFamily; fresh: boolean } | { ok: false; why: string };
/** Whether a cell may run this angle now; `fresh` when it adds the category's next angle to the sequence. */
export function checkAngle(input: { family: unknown; reason: string; tool: SearchTool; sequence: AngleStep[]; tried: string[]; context: AngleContext }): AngleCheck {
  const { tool, sequence, tried } = input;
  const family = input.family as AngleFamily;
  if (!ANGLE_FAMILIES.includes(family)) return { ok: false, why: `every search declares its angle family in "angle", one of: ${ANGLE_FAMILIES.join(", ")}` };
  if (!sequence.length && family !== "anchor") return { ok: false, why: "the first angle in every category is the Anchor: run anchor first, and code writes its query" };
  const why = notApplicable(family, tool, input.context);
  if (why) return { ok: false, why: `${family} doesn't apply here: ${why}` };
  if (tried.includes(family)) return { ok: false, why: `already tried ${family} here; pick another` };
  const applicable = applicableFamilies(tool, input.context);
  const pending = pendingAngle(sequence, tried, applicable);
  if (pending && pending.family !== family) return { ok: false, why: `${tool} still has to run ${pending.family}, this category's angle from step ${pending.step}${pending.reason ? ` (${pending.reason})` : ""}. Every tool runs the same angles: run ${pending.family} now, in ${tool}'s own phrasing` };
  if (pending) return { ok: true, family, fresh: false };
  if (family !== "anchor" && !input.reason.trim()) return { ok: false, why: `${family} would be this category's next angle: say why in angle_reason, in a few words` };
  return { ok: true, family, fresh: true };
}

/** The anchor's query: the place and the category's main term. The same for every tool. */
export function anchorQuery(place: { place: string; parent: string | null }, category: PriorityTopic) {
  return `${place.place}${place.parent ? ` ${place.parent}` : ""} ${VOCABULARY[category]?.anchor ?? category.replace(/_/g, " ")}`;
}

const SMALL_WORDS = new Set(["a", "an", "and", "the", "of", "in", "on", "for", "to", "at", "by", "or", "with", "from", "near", "is", "are", "does", "do", "where", "what", "which", "who", "how", "that", "this", "its", "their", "pages", "page", "site", "sites"]);
/** A query's words for the overlap check: lowercase, without operators' names, small words or the place's own name. */
export function queryWords(query: string, placeWords: string[] = []) {
  const place = new Set(placeWords.flatMap((name) => name.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean));
  const words = query.toLowerCase().replace(/(^|\s)-?(site|inurl|intitle|filetype|after|before):/g, " ").split(/[^a-z0-9]+/).filter((word) => word && !SMALL_WORDS.has(word) && !place.has(word));
  return new Set(words);
}
/** The earlier query in the cell this one is too close to, or null. Words are compared as sets (Jaccard). */
export function nearDuplicate(query: string, earlier: string[], placeWords: string[] = [], threshold = QUERY_OVERLAP) {
  const mine = queryWords(query, placeWords);
  if (!mine.size) return null;
  for (const other of earlier) {
    const theirs = queryWords(other, placeWords);
    if (!theirs.size) continue;
    const shared = [...mine].filter((word) => theirs.has(word)).length;
    if (shared / new Set([...mine, ...theirs]).size >= threshold) return other;
  }
  return null;
}

/** Capitalised words that start an institution's or a place's name, not a person's. */
const NAME_PARTS = new Set(["high", "middle", "elementary", "school", "schools", "district", "police", "fire", "department", "city", "county", "park", "parks", "library", "church", "community", "council", "centre", "center", "hospital", "public", "station", "precinct", "north", "south", "east", "west", "saint", "st", "lake", "hill", "valley", "street", "avenue", "chamber", "commerce", "association", "club", "league", "athletics", "pta", "ptsa", "board", "news", "the", "of", "and"]);
/**
 * Why a Roles query isn't one, or null: it must use a title, and must not name a person. Names the
 * place kit knows (institutions, schools, places) are taken out first, so "Nathan Hale athletic
 * director" is a school's title, while "John Smith athletic director" names a person.
 */
export function roleQueryProblem(query: string, category: PriorityTopic, known: string[]) {
  let text = query.replace(/(^|\s)-?(site|inurl|intitle|filetype):\S+/gi, " ").replace(/["“”]/g, " ");
  // A known name also counts without its trailing kind: "Nathan Hale High School" clears "Nathan Hale".
  const short = (name: string) => { const words = name.split(/\s+/); while (words.length > 1 && NAME_PARTS.has(words.at(-1)!.toLowerCase())) words.pop(); return words.join(" "); };
  const names = [...new Set(known.filter(Boolean).flatMap((name) => [name, short(name)]))];
  for (const name of names.sort((a, b) => b.length - a.length)) text = text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  const roles = [...ROLE_WORDS, ...(VOCABULARY[category]?.roles ?? [])].map((role) => role.toLowerCase());
  const lower = text.toLowerCase();
  if (!roles.some((role) => new RegExp(`\\b${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`).test(lower))) return `a Roles angle uses a title, like ${(VOCABULARY[category]?.roles ?? ROLE_WORDS).slice(0, 3).join(", ")}`;
  const roleWords = new Set(roles.flatMap((role) => role.split(/\s+/)));
  const person = [...text.matchAll(/\b([A-Z][a-z'’-]+)(?:\s+[A-Z]\.)?\s+([A-Z][a-z'’-]+)\b/g)].find((match) => [match[1], match[2]].every((word) => !NAME_PARTS.has(word.toLowerCase()) && !roleWords.has(word.toLowerCase())));
  if (person) return `it looks like it names a person (${person[0]}): use the title, never the name`;
  return null;
}

/** Why a tool-native query doesn't use what only that tool can do, or null. */
export function nativeQueryProblem(tool: SearchTool, query: string) {
  const operators = /(?:^|\s)-?(site|inurl|intitle|filetype):\S/i;
  if (tool === "dork") return /(?:^|\s)(site|inurl|intitle):\S/i.test(query) ? null : "dork's tool-native angle uses site: on a confirmed site, inurl: or intitle:";
  if (tool === "exa") return !operators.test(query) && query.split(/\s+/).filter(Boolean).length >= NATIVE_WORDS ? null : `Exa's tool-native angle is a plain-sentence description of the page you want, at least ${NATIVE_WORDS} words and no operators`;
  return "Tavily's tool-native angle is explore: explore a confirmed hub site instead";
}

export type AngleResult = "hit" | "miss" | "waiting" | "not yet";
export type AngleRow = {
  family: AngleFamily; label: string; reason: string; step: number; tool: SearchTool; results: Record<SearchTool, AngleResult>; queries: Partial<Record<SearchTool, string>>;
  /** Categories a tool's search on this angle found a hit for, other than this one: those sources were found while searching this category. */
  elsewhere: Partial<Record<SearchTool, string[]>>;
};
/** Each category's sequence of angles, with what each tool's search on that angle came to. */
export function angleRows(sequences: AngleSequences, searches: CellSearch[], sources: GridSource[], startHosts: string[], topics: PriorityTopic[]) {
  const { byStep } = searchOutcomes(sources, startHosts);
  return topics.map((category) => ({
    category,
    angles: (sequences[category] ?? []).map((angle): AngleRow => {
      const runs = Object.fromEntries(SEARCH_TOOLS.map((tool) => [tool, searches.find((search) => search.category === category && search.tool === tool && search.angle === angle.family)]));
      const result = (search: CellSearch | undefined): AngleResult => {
        if (!search) return "not yet";
        const outcome = byStep.get(search.step);
        return outcome?.hits ? "hit" : outcome?.pending ? "waiting" : "miss";
      };
      return {
        family: angle.family, label: ANGLE_LABELS[angle.family] ?? angle.family, reason: angle.reason, step: angle.step, tool: angle.tool,
        results: Object.fromEntries(SEARCH_TOOLS.map((tool) => [tool, result(runs[tool])])) as Record<SearchTool, AngleResult>,
        queries: Object.fromEntries(SEARCH_TOOLS.flatMap((tool) => runs[tool]?.query ? [[tool, runs[tool]!.query!]] : [])),
        elsewhere: Object.fromEntries(SEARCH_TOOLS.flatMap((tool) => { const other = runs[tool] ? byStep.get(runs[tool]!.step)?.elsewhere ?? [] : []; return other.length ? [[tool, [...new Set(other)]]] : []; })),
      };
    }),
  }));
}

/** The families as the agent reads them. */
export const familyLines = () => ANGLE_FAMILIES.map((family) => `- ${family}: ${FAMILY_TEXT[family]}`).join("\n");
/** Each category's vocabulary as the agent reads it. */
export const vocabularyLines = (topics: PriorityTopic[]) => topics.map((topic) => {
  const words = VOCABULARY[topic];
  return words ? `- ${topic}: anchor term "${words.anchor}"; ${words.terms.join(", ")}. Roles: ${words.roles.join(", ") || "none listed"}` : `- ${topic}: no vocabulary in the playbook`;
}).join("\n");
