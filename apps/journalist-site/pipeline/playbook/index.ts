/**
 * The scraping rules, read from `compiled.json`, which `npm run playbook` builds from the top-level
 * playbook/ folder. It is imported, not read from disk, so it is in every bundle by construction.
 * A rule that is missing or of the wrong type throws when the module asking for it loads, so a bad
 * playbook fails the build. Regexes are kept as strings and compiled once, here.
 */
import compiled from "./compiled.json";

export type Consumer = "manual" | "agent" | "google" | "non_google";
export type Rule = {
  id: string; category: string; part: string; consumers: Consumer[]; from: string; text?: string; reason?: string; set?: string; order?: number; stage?: string; pattern?: string; regex?: string; flags?: string;
  value?: string | number; values?: string[]; map?: Record<string, unknown>; verdict?: string; source_type?: string;
  osm?: { kind: string; tag: string; priority: number; story_kind?: string };
  opendata?: { topic: string; query: string; state_level: boolean };
  address?: { label: string };
  for_each?: { list: string; limit: number; kinds?: string[] };
};
export type Category = { id: string; label: string; target: boolean; topic: string | null };
type Operator = "keep" | "drop" | { parameter: string; wildcards?: "drop" };
export type Service = { consumer: "google" | "non_google"; label: string; operators: Record<string, Operator>; strip?: { match: "after_space" | "word_start"; ignore_case: boolean }; request?: Record<string, unknown> };

const playbook = compiled as unknown as { version: string; categories: Category[]; rules: Rule[]; services: Record<string, Service>; skill: string };
if (!/^[0-9a-f]{16}$/.test(playbook.version ?? "") || !playbook.rules?.length || !playbook.skill) throw new Error("The compiled playbook is empty or damaged: run `npm run playbook`.");

/** The content hash of these rules, recorded on each run. */
export const PLAYBOOK_VERSION = playbook.version;
export const CATEGORIES_IN_PLAYBOOK = playbook.categories;
export const PLAYBOOK_RULES = playbook.rules;
export const PLAYBOOK_SERVICES = playbook.services;
/** The mapping agent's instructions, with their generated category section. */
export const PLAYBOOK_SKILL = playbook.skill;

const byId = new Map(playbook.rules.map((item) => [item.id, item]));
const patterns = new Map(playbook.rules.flatMap((item) => item.regex ? [[item.id, new RegExp(item.regex, item.flags)] as const] : []));
const topics = new Map(playbook.categories.map((item) => [item.id, item.topic]));

export function rule(id: string) {
  const found = byId.get(id);
  if (!found) throw new Error(`The playbook has no rule ${id}`);
  return found;
}
function field<T>(id: string, name: keyof Rule, type?: string) {
  const found = rule(id)[name];
  if (found === undefined || (type && typeof found !== type)) throw new Error(`The playbook rule ${id} has no ${type ?? ""} ${name}`);
  return found as T;
}
/** A number from `when_to_stop`. */
export const limit = (id: string) => field<number>(id, "value", "number");
export const setting = (id: string) => field<string>(id, "value", "string");
export const list = (id: string) => field<string[]>(id, "values");
export const table = <T = string>(id: string) => field<Record<string, T>>(id, "map");
export const template = (id: string) => field<string>(id, "pattern", "string");
export function regex(id: string) {
  const found = patterns.get(id);
  if (!found) throw new Error(`The playbook rule ${id} has no regex`);
  return found;
}

export type SetRule = Rule & { section: string; topic: string | null; test: RegExp };
/** One set's rules, in their order. Each file's rules belong to its section and topic. */
export function ruleSet(set: string): SetRule[] {
  const found = playbook.rules.filter((item) => item.set === set).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!found.length) throw new Error(`The playbook has no rule set ${set}`);
  return found.map((item) => ({ ...item, section: item.category, topic: topics.get(item.category) ?? null, test: patterns.get(item.id) as RegExp }));
}
/** A category's queries for one stage, in file order. */
export const queriesFor = (stage: string, category?: string) => playbook.rules.filter((item) => item.stage === stage && (!category || item.category === category));

/** Fills `{placeholders}`. One the caller doesn't supply is a coding mistake, not a missing value. */
export function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (values[name] === undefined) throw new Error(`Nothing to fill {${name}} with in: ${text}`);
    return String(values[name]);
  });
}
