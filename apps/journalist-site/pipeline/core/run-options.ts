/**
 * What one run is allowed to do. Options are chosen at kick-off, saved on the run, and read
 * through an async context while its jobs execute, so the fetcher, the paid-call gateway, the
 * floor and the assembler all see the same choices without passing them around.
 *
 * Environment defaults (each overridable per run on the kick-off panel):
 *   NEWSBEE_RUN_MODE, NEWSBEE_PIPELINE_FLOW, NEWSBEE_MAP_FLOW, NEWSBEE_GUARDRAIL_PROFILE, NEWSBEE_GUARDRAILS_OFF,
 *   NEWSBEE_ACCESS_POLICY, NEWSBEE_ACCESS_IGNORE, NEWSBEE_COUNT_HISTORY, NEWSBEE_PAID_ALLOW,
 *   NEWSBEE_PAID_BUDGETS, NEWSBEE_EXTERNAL_OFF, NEWSBEE_SEARCH_PROVIDER, NEWSBEE_URL_CLASSIFIER,
 *   NEWSBEE_PRIORITY_TOPICS.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "mongodb";
import {
  ACCESS_RULES, CLASSIFIER_MODES, FREE_SERVICES, GUARDRAIL_GROUPS, PAID_SERVICE_IDS, PAID_SERVICES, PRIORITY_TOPICS, SEARCH_PROVIDERS,
  type AccessRule, type FreeService, type GuardrailGroup, type PaidService, type PriorityTopic, type RunOptions,
} from "./run-values";

export * from "./run-values";

function list(value: string | undefined) { return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean); }
function within<T extends string>(values: unknown, allowed: readonly T[], name: string): T[] {
  const items = Array.isArray(values) ? values.map(String) : list(typeof values === "string" ? values : undefined);
  for (const item of items) if (!allowed.includes(item as T)) throw new Error(`${name} must be from: ${allowed.join(", ")}`);
  return [...new Set(items)] as T[];
}
function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (!allowed.includes(String(value) as T)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return String(value) as T;
}
/** Unset means caps off, so every item and source is kept; "none" turns every group back on. */
function guardrailsOff(value: string | undefined) {
  if (value === undefined) return ["caps"] as GuardrailGroup[];
  if (value.trim().toLowerCase() === "none") return [];
  return within<GuardrailGroup>(value, GUARDRAIL_GROUPS, "NEWSBEE_GUARDRAILS_OFF");
}
const BUDGETS = Object.fromEntries(PAID_SERVICES.map((service) => [service.id, service.budget])) as Record<PaidService, number>;

/** The defaults from the environment, before any kick-off choice. */
export function defaultRunOptions(env: NodeJS.ProcessEnv = process.env): RunOptions {
  const budgets = Object.fromEntries(list(env.NEWSBEE_PAID_BUDGETS).map((item) => { const [id, calls] = item.split(":"); return [id, Number(calls)]; }));
  const allowed = within<PaidService>(env.NEWSBEE_PAID_ALLOW, PAID_SERVICE_IDS, "NEWSBEE_PAID_ALLOW");
  return {
    mode: choice(env.NEWSBEE_RUN_MODE, ["autopilot", "manual"] as const, "autopilot", "NEWSBEE_RUN_MODE"),
    flow: choice(env.NEWSBEE_PIPELINE_FLOW, ["current", "agentic"] as const, "current", "NEWSBEE_PIPELINE_FLOW"),
    map_flow: choice(env.NEWSBEE_MAP_FLOW ?? env.NEWSBEE_PIPELINE_FLOW, ["current", "agentic"] as const, "current", "NEWSBEE_MAP_FLOW"),
    guardrails: choice(env.NEWSBEE_GUARDRAIL_PROFILE, ["strict", "exploration"] as const, "strict", "NEWSBEE_GUARDRAIL_PROFILE"),
    guardrails_off: guardrailsOff(env.NEWSBEE_GUARDRAILS_OFF),
    access: choice(env.NEWSBEE_ACCESS_POLICY, ["respect", "relaxed"] as const, "respect", "NEWSBEE_ACCESS_POLICY"),
    access_ignore: within<AccessRule>(env.NEWSBEE_ACCESS_IGNORE, ACCESS_RULES, "NEWSBEE_ACCESS_IGNORE"),
    count_history: !["0", "off", "false", "no"].includes((env.NEWSBEE_COUNT_HISTORY ?? "on").trim().toLowerCase()),
    paid: Object.fromEntries(allowed.map((id) => [id, Number.isFinite(budgets[id]) ? budgets[id] : BUDGETS[id]])),
    external_off: within<FreeService>(env.NEWSBEE_EXTERNAL_OFF, FREE_SERVICES.map((service) => service.id), "NEWSBEE_EXTERNAL_OFF"),
    search_provider: choice(env.NEWSBEE_SEARCH_PROVIDER, SEARCH_PROVIDERS, "serpapi", "NEWSBEE_SEARCH_PROVIDER"),
    classifier: choice(env.NEWSBEE_URL_CLASSIFIER, CLASSIFIER_MODES, "off", "NEWSBEE_URL_CLASSIFIER"),
    topics: env.NEWSBEE_PRIORITY_TOPICS?.trim() ? within<PriorityTopic>(env.NEWSBEE_PRIORITY_TOPICS, PRIORITY_TOPICS.map((topic) => topic.id), "NEWSBEE_PRIORITY_TOPICS") : PRIORITY_TOPICS.map((topic) => topic.id),
  };
}

export class RunOptionsError extends Error {}

export function isDeployed(env: NodeJS.ProcessEnv = process.env) {
  return (env.NEWSBEE_MODE ?? "local").trim().toLowerCase() === "cloud" || Boolean(env.VERCEL);
}

/** Merge kick-off choices over the defaults, and refuse what this environment does not allow. */
export function resolveRunOptions(input: unknown, env: NodeJS.ProcessEnv = process.env): RunOptions {
  const base = defaultRunOptions(env);
  const choices = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof RunOptions, unknown>>;
  let options: RunOptions;
  try {
    const paid: Partial<Record<PaidService, number>> = {};
    for (const [id, calls] of Object.entries((choices.paid as Record<string, unknown> | undefined) ?? base.paid)) {
      if (!PAID_SERVICE_IDS.includes(id as PaidService)) throw new Error(`Unknown paid service: ${id}`);
      const budget = Number(calls);
      if (!Number.isFinite(budget) || budget < 0) throw new Error(`The budget for ${id} must be a non-negative number`);
      paid[id as PaidService] = budget;
    }
    options = {
      mode: choice(choices.mode, ["autopilot", "manual"] as const, base.mode, "Run mode"),
      flow: choice(choices.flow, ["current", "agentic"] as const, base.flow, "Flow"),
      map_flow: choice(choices.map_flow, ["current", "agentic"] as const, base.map_flow ?? base.flow, "Source map method"),
      guardrails: choice(choices.guardrails, ["strict", "exploration"] as const, base.guardrails, "Guardrails"),
      guardrails_off: choices.guardrails_off === undefined ? base.guardrails_off : within<GuardrailGroup>(choices.guardrails_off, GUARDRAIL_GROUPS, "Guardrail groups"),
      access: choice(choices.access, ["respect", "relaxed"] as const, base.access, "Access"),
      access_ignore: choices.access_ignore === undefined ? base.access_ignore : within<AccessRule>(choices.access_ignore, ACCESS_RULES, "Access rules"),
      count_history: choices.count_history === undefined ? base.count_history : Boolean(choices.count_history),
      paid,
      external_off: choices.external_off === undefined ? base.external_off : within<FreeService>(choices.external_off, FREE_SERVICES.map((service) => service.id), "External services"),
      search_provider: choice(choices.search_provider, SEARCH_PROVIDERS, base.search_provider, "Search provider"),
      classifier: choice(choices.classifier, CLASSIFIER_MODES, base.classifier, "Classifier"),
      topics: choices.topics === undefined ? base.topics : within<PriorityTopic>(choices.topics, PRIORITY_TOPICS.map((topic) => topic.id), "Priority topics"),
      story_limit: Number(choices.story_limit) > 0 ? Math.floor(Number(choices.story_limit)) : null,
    };
  } catch (error) {
    throw new RunOptionsError(error instanceof Error ? error.message : String(error));
  }
  if (isDeployed(env) && options.search_provider === "fixture") throw new RunOptionsError("The fixture search provider is local only.");
  return options;
}

/** What a run created before run options existed behaves like: today's manual, unrestricted flow. */
export const LEGACY_OPTIONS: RunOptions = {
  mode: "manual", flow: "current", guardrails: "strict", guardrails_off: [], access: "respect", access_ignore: [], count_history: true,
  paid: Object.fromEntries(["gemini", "openai_compatible", "tavily"].map((id) => [id, Number.MAX_SAFE_INTEGER])), external_off: [], search_provider: "serpapi", classifier: "off", topics: [],
};

export type RunContext = {
  db: Db;
  runId: string;
  locationId: string;
  options: RunOptions;
  /** Access rules this job actually skipped, written onto what it collects. */
  overrides: Set<AccessRule>;
};
const context = new AsyncLocalStorage<RunContext>();

export function withRunContext<T>(value: Omit<RunContext, "overrides">, operation: () => T): T {
  return context.run({ ...value, overrides: new Set() }, operation);
}
export function runContext() { return context.getStore() ?? null; }
export function currentOptions(): RunOptions { return context.getStore()?.options ?? LEGACY_OPTIONS; }

/** Whether a guardrail group is off for the current run. */
export function rulesOff(group: GuardrailGroup) {
  const options = currentOptions();
  return options.guardrails === "exploration" || options.guardrails_off.includes(group);
}

/** Whether an access rule is ignored; noting that it mattered when `used` is set. */
export function accessIgnored(rule: AccessRule, used = false) {
  const options = currentOptions();
  const ignored = options.access === "relaxed" && (!options.access_ignore.length || options.access_ignore.includes(rule));
  if (ignored && used) context.getStore()?.overrides.add(rule);
  return ignored;
}

/** Whether stored content from relaxed runs may be read by this run. */
export function relaxedContentAllowed() { return currentOptions().access === "relaxed"; }

/** A count limit that applies only while the caps group is on; with caps off there is none. */
export function itemCap(max: number) {
  return rulesOff("caps") ? Infinity : max;
}

/** Limits that the caps group controls. With caps off a site is read until its time budget ends. */
export function limits() {
  return {
    ratedPerSection: itemCap(30),
    candidatesPerSection: itemCap(20),
    publishedPerSection: itemCap(10),
    perSourceInSection: itemCap(5),
    widerItems: itemCap(3),
    webPageBudget: itemCap(10),
    webMaxItems: itemCap(25),
    webMaxPages: itemCap(5),
    newWebPerHost: itemCap(2),
  };
}
