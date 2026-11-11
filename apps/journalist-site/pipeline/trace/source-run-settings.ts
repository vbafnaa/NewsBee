/**
 * The Source runs tab's settings, tools and stages, with no server imports, so the page and the
 * server read the same lists. A source map run's settings are its run options seen by stage:
 * Access, Search (the agent loop and its tools), Scrape (the paid fallbacks) and Think (the
 * Model check). `settingsOf` reads them back from what a run recorded; `choicesFor` turns the
 * Next run settings into run options for the existing start path. Relaxed and the model check off
 * are test options that work locally and deployed, and each run records which it used.
 */
import { PAID_SERVICES, type PaidService, type RunOptions } from "../core/run-values";
import { SECTIONS } from "../sourcemap/sections";

export const DORK_SERVICES = [{ id: "brightdata", label: "Bright Data" }, { id: "serpapi", label: "SerpApi" }] as const;
export type DorkService = typeof DORK_SERVICES[number]["id"];

export type RunSettings = {
  /** Respect site rules; off means Relaxed. */
  respect: boolean;
  /** The mapping agent after the fixed readers. Its search tools need it. */
  agent: boolean;
  dork: boolean; dork_service: DorkService; exa: boolean; tavily: boolean;
  /** Paid fallbacks for opening pages. ScrapingBee is never used in the agent's own steps. */
  scrapingbee: boolean; brightdata_open: boolean;
  /** Off only for baseline tests (the fixed pipeline alone). */
  gemini_check: boolean;
  /** The search depth a past run recorded, shown as it was. Every run is exhaustive now: the agent searches until every category × tool goes dry. */
  depth?: "exhaustive" | "enough" | null;
};

export const DEFAULT_SETTINGS: RunSettings = { respect: true, agent: true, dork: true, dork_service: "brightdata", exa: true, tavily: true, scrapingbee: false, brightdata_open: false, gemini_check: true };

/** The paid services each switch ticks. Model services (Gemini and the agent model) stay as the defaults set them. */
const SWITCHED: PaidService[] = ["brightdata", "serpapi", "exa", "tavily", "scrapingbee", "brightdata_open"];
const BUDGETS = Object.fromEntries(PAID_SERVICES.map((service) => [service.id, service.budget])) as Record<PaidService, number>;

/** What a run used, from the options it recorded. */
export function settingsOf(options: RunOptions | null | undefined): RunSettings {
  if (!options) return { ...DEFAULT_SETTINGS, agent: false, dork: false, exa: false, tavily: false };
  const paid = (id: PaidService) => options.paid?.[id] !== undefined;
  const agent = (options.map_flow ?? options.flow) === "agentic";
  // As the agent picks it: the run's search provider when it is a Google one and ticked, else Bright Data, then SerpApi.
  const chosen = DORK_SERVICES.map((service) => service.id).find((id) => id === options.search_provider);
  const dorkService: DorkService = [chosen, "brightdata" as const, "serpapi" as const].find((id) => id && paid(id)) ?? chosen ?? "brightdata";
  return {
    respect: options.access !== "relaxed", agent,
    dork: agent && (paid(dorkService) || options.search_provider === "fixture"), dork_service: dorkService,
    exa: agent && (paid("exa") || options.search_provider === "fixture"), tavily: agent && (paid("tavily") || options.search_provider === "fixture"),
    scrapingbee: paid("scrapingbee"), brightdata_open: paid("brightdata_open"), gemini_check: options.gemini_check !== false,
    // Only runs from #134 recorded a depth; Enough runs searched until every category was covered.
    depth: options.search_depth ?? null,
  };
}

/** Run options for a source map run with these settings, over the defaults (which keep their model budgets and everything else). */
export function choicesFor(settings: RunSettings, defaults: RunOptions): RunOptions {
  const paid = { ...defaults.paid };
  for (const id of SWITCHED) delete paid[id];
  const tick = (id: PaidService) => { paid[id] = defaults.paid[id] ?? BUDGETS[id]; };
  if (settings.agent && settings.dork) tick(settings.dork_service);
  if (settings.agent && settings.exa) tick("exa");
  if (settings.agent && settings.tavily) tick("tavily");
  if (settings.scrapingbee) tick("scrapingbee");
  if (settings.brightdata_open) tick("brightdata_open");
  // A local fixture run answers every search tool for free; anything else names the dork service.
  const fixture = defaults.search_provider === "fixture";
  return {
    ...defaults, paid, map_flow: settings.agent ? "agentic" : "current", access: settings.respect ? "respect" : "relaxed",
    search_provider: fixture ? "fixture" : settings.dork_service, gemini_check: settings.gemini_check,
  };
}

/** A short name for a run's search tools, for the Run picker. */
export function toolsSummary(settings: RunSettings) {
  const tools = [settings.dork && "Dorking", settings.exa && "Exa", settings.tavily && "Tavily"].filter(Boolean) as string[];
  const search = !settings.agent ? "Fixed readers only" : tools.length === 3 ? "All search tools" : tools.length === 1 ? `${tools[0]} only` : tools.length ? tools.join(" and ") : "Agent, no search tools";
  return [search, settings.agent && settings.depth === "enough" && "Enough (an older run)", !settings.respect && "Relaxed", !settings.gemini_check && "Model check off"].filter(Boolean).join(" · ");
}

/** Who turned a page up: the fixed readers, one of the agent's search tools, a link on a page, or the agent's own pick. */
export const TOOLS = {
  fixed: { label: "Fixed readers", color: "var(--tool-fixed)" },
  dork: { label: "Dorking", color: "var(--tool-dork)" },
  exa: { label: "Exa", color: "var(--tool-exa)" },
  tavily: { label: "Tavily", color: "var(--tool-tavily)" },
  link: { label: "Followed link", color: "var(--tool-link)" },
  agent: { label: "Agent's own pick", color: "var(--tool-agent)" },
} as const;
export type ToolId = keyof typeof TOOLS;
export const TOOL_IDS = Object.keys(TOOLS) as ToolId[];

/** The funnel's stages. Found holds every page; each page sits in one of the others once opened. */
export const STAGES = [
  { id: "found", label: "Found", detail: "Every page a reader or tool turned up" },
  { id: "opened", label: "Opened", detail: "Pages actually opened" },
  { id: "link_only", label: "Kept as a link only", detail: "Couldn't be read (blocked, paywalled, a platform we never read), kept as a link and sent to the model check" },
  { id: "code_fail", label: "Rejected by code check", detail: "Dropped by a code check, never sent to the model check" },
  { id: "gemini_reject", label: "Rejected by the model check", detail: "Passed code, rejected by the model check" },
  { id: "passed", label: "Passed both", detail: "Saved active, so editions read it (proposed for your review while proposed-until-approved is on)" },
] as const;
export type StageId = typeof STAGES[number]["id"];

export const READER_LABELS: Record<string, string> = { fetcher: "Fetcher", jina: "Jina", scrapingbee: "ScrapingBee", brightdata: "Bright Data", unrecorded: "Opened" };

/** Where a page got to: `found` (never opened), `opened` (not judged), or one of the last three stages. */
export type PageStage = "found" | "opened" | "code_fail" | "gemini_reject" | "passed";
export type CodeResult = "pass" | "unclear" | "fail" | "link_only" | "not_opened" | "not_checked";
/**
 * The code check as the Every page table shows it: exactly three states. Unclear locality passed
 * code and went on to the model check; a page that was never opened or never checked has none.
 */
export type CodeState = "passed" | "link_only" | "rejected";
export function codeState(result: CodeResult): CodeState | null {
  return result === "pass" || result === "unclear" ? "passed" : result === "link_only" ? "link_only" : result === "fail" ? "rejected" : null;
}

/** One page in a run, from the decision log, the agent's state and the source map. */
export type PageRow = {
  key: string; url: string; name: string | null; source_id: string | null; category: string | null;
  tool: ToolId; found: { how: string; query: string | null; step: number | null };
  /** Every tool that found it, when several did; the page is listed once and each of them is credited. */
  tools?: ToolId[];
  opened: { reader: string | null; why: string | null; fallbacks: Array<{ reader: string; why: string }> };
  /** For a page found but not opened, `skipped_by` says whether code or the agent gave the reason. */
  code: { result: CodeResult; reason: string | null; skipped_by?: "code" | "agent" | null };
  gemini: { verdict: "accept" | "reject" | null; reason_code: string | null; reason: string | null; evidence: string | null; note: string | null; model: string | null } | null;
  decision: { decision: "accept" | "reject" | null; reason_code: string | null; reason: string | null } | null;
  /** The final review's flags on the source this page became: strong, usable or weak, and a likely duplicate. */
  flags?: { strength: "strong" | "usable" | "weak" | null; duplicate_of: string | null; reason: string | null } | null;
  status: string | null; stage: PageStage; disagrees: boolean; at: number;
};

export type PageFilters = { q?: string; tool?: string; category?: string; stage?: string; disagrees?: boolean };

/** Found holds every page; Opened and Kept as a link only cut across the rest (a link-only page can still be accepted or rejected by the model check). */
export function inStage(row: Pick<PageRow, "stage" | "opened" | "code">, stage: string | undefined) {
  if (!stage || stage === "found") return true;
  if (stage === "opened") return Boolean(row.opened.reader);
  if (stage === "link_only") return row.code.result === "link_only";
  return row.stage === stage;
}

/** The Every page filters: address search, tool, category, stage, and where your decision differs from the model check's. */
export function filterPages(rows: PageRow[], filters: PageFilters) {
  const text = filters.q?.trim().toLowerCase() ?? "";
  return rows.filter((row) => inStage(row, filters.stage) && (!filters.tool || row.tool === filters.tool || Boolean(row.tools?.includes(filters.tool as ToolId))) && (!filters.category || row.category === filters.category)
    && (!text || row.url.toLowerCase().includes(text) || (row.name ?? "").toLowerCase().includes(text)) && (!filters.disagrees || row.disagrees));
}

/** Where a page ended, for ordering Every page within a category: passed both, link only, rejected by the model check, rejected by code, then the rest (not opened or not judged). */
export type PageOutcome = "passed" | "link_only" | "gemini_reject" | "code_fail" | "other";
const OUTCOME_ORDER: PageOutcome[] = ["passed", "link_only", "gemini_reject", "code_fail", "other"];
export function pageOutcome(row: Pick<PageRow, "stage" | "code">): PageOutcome {
  if (row.stage === "passed" || row.stage === "gemini_reject" || row.stage === "code_fail") return row.stage;
  return row.code.result === "link_only" ? "link_only" : "other";
}

export type PageGroup = { category: string | null; label: string; rows: PageRow[]; counts: { total: number; passed: number; link_only: number; rejected: number }; heading: string };

/**
 * Every page, one group per category in the site's usual order, with pages of no (or an unknown)
 * category last under Uncategorised. Pass rows already filtered: the counts are of what is shown.
 */
export function groupPages(rows: PageRow[]): PageGroup[] {
  const known = new Map<string, string>(SECTIONS.map((section) => [section.id, section.label]));
  const order = [...known.keys(), null];
  const groups = new Map<string | null, PageRow[]>();
  for (const row of rows) {
    const category = row.category && known.has(row.category) ? row.category : null;
    groups.set(category, [...(groups.get(category) ?? []), row]);
  }
  return order.filter((category) => groups.has(category)).map((category) => {
    const mine = groups.get(category)!.map((row, index) => ({ row, index, outcome: pageOutcome(row) }))
      .sort((a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome) || a.index - b.index);
    const count = (...outcomes: PageOutcome[]) => mine.filter((item) => outcomes.includes(item.outcome)).length;
    const counts = { total: mine.length, passed: count("passed"), link_only: count("link_only"), rejected: count("gemini_reject", "code_fail") };
    const label = category ? known.get(category)! : "Uncategorised";
    const parts = [counts.passed ? `${counts.passed} passed both` : null, counts.link_only ? `${counts.link_only} link only` : null, counts.rejected ? `${counts.rejected} rejected` : null].filter(Boolean);
    return { category, label, rows: mine.map((item) => item.row), counts, heading: [`${label} (${counts.total})`, ...parts].join(" · ") };
  });
}
