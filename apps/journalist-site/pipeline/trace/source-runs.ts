/**
 * The Source runs tab: one source map run (Pipeline 1), page by page, from what the run recorded.
 * It reads the run's options (the settings it used), the decision log (each page's code checks,
 * the reader that opened it and the model check's verdict), the agent's saved state (its steps,
 * the pages its tools turned up and how it stopped), the run's search queries and paid calls, and
 * the source map (a person's decision, from the same review store as All sources). Nothing is
 * estimated: what a run didn't record is shown as not recorded. A test-mode run
 * (NEWSBEE_SOURCE_RUNS_ISOLATED) is read from its own store instead of the source map, so it shows
 * exactly what it found however many runs come after, and a person's decisions come by page
 * (`page_decisions`), so a page decided in one run shows that decision in every run.
 */
import type { Db } from "mongodb";
import { AGENT_STATE, cellDryOf, gridOf, type AgentState, type Lead } from "../agent/map-sources";
import { angleRows } from "../agent/search-angles";
import { SEARCH_TOOLS, yieldCurves, type Cell, type Grid, type SearchTool } from "../agent/search-grid";
import { DO_NOT_SCRAPE } from "../connectors/fetcher";
import { TOPIC_SECTIONS } from "../discovery/topics";
import { runs, type PipelineRun } from "../orchestration/runs";
import { searchQueries } from "../search/provider";
import { CATEGORIES, SECTION_LABELS } from "../sourcemap/sections";
import { hostOf, METHOD_LABELS, normaliseUrl, pageDecisions, pageKey, runSources, sourceMap, type PageDecision, type SourceRecord } from "../sourcemap/store";
import { LEGACY_MODEL_SERVICES, PAID_SERVICES, paidAllowance, type PriorityTopic } from "../core/run-values";
import { COLLECTIONS } from "../storage/mongo";
import { runDecisions, type Decision } from "./decisions";
import { apiCalls, HARD_LIMITS, limitWindow, RUN_MINUTES } from "./gateway";
import { inStage, settingsOf, STAGES, TOOL_IDS, toolsSummary, type CodeResult, type PageRow, type PageStage, type RunSettings, type ToolId } from "./source-run-settings";

type Evidence = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" && value ? value : null;
const evidenceOf = (row: Decision) => (row.evidence ?? {}) as Evidence;
const keyOf = (url: string) => normaliseUrl(url);
const isUrl = (value: string) => /^https?:\/\//i.test(value);
const clip = (value: string, length: number) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
const firstLine = (value: string) => value.split("\n")[0]?.trim() ?? "";
const sectionOf = (topic: string | null | undefined) => topic ? TOPIC_SECTIONS[topic as PriorityTopic] ?? null : null;

/** Map runs only, newest first, numbered from the location's first. */
export async function sourceRunList(db: Db, locationId: string) {
  const rows = await runs(db).find({ location_id: locationId, kind: "map" }, { projection: { status: 1, created_at: 1, completed_at: 1, options: 1, isolated: 1 } }).sort({ created_at: 1 }).toArray();
  const listed = rows.map((row, index) => {
    const settings = settingsOf(row.options);
    return { run_id: row._id, number: index + 1, status: row.status, created_at: row.created_at, completed_at: row.completed_at, summary: toolsSummary(settings), recorded: Boolean(row.options), isolated: row.isolated === true };
  }).reverse();
  return { runs: listed, completed: rows.filter((row) => row.status === "mapped").length };
}

/** A tool from what the decision log or agent recorded: a fixed reader's method, or the agent's search tool or link. */
function toolOf(family: string | null, method: string | null): ToolId {
  if (family?.startsWith("agent:")) {
    const tool = family.slice(6);
    return tool === "dork" || tool === "exa" || tool === "tavily" ? tool : tool === "explore" ? "tavily" : tool === "open" || tool === "propose" ? "link" : "agent";
  }
  if (method === "agent") return "agent";
  return family === "site_section" ? "link" : "fixed";
}
/** Tools in the order the grid and the charts use: fixed readers, Dorking, Exa, Tavily, then links and the agent. */
const inToolOrder = (tools: ToolId[]) => [...new Set(tools)].sort((a, b) => TOOL_IDS.indexOf(a) - TOOL_IDS.indexOf(b));
/** Every tool credited with a lead: each search tool that returned it. */
const leadTools = (lead: Lead | undefined | null): ToolId[] => lead ? inToolOrder((lead.tools ?? [lead.tool]).map(leadTool)) : [];
function leadTool(tool: string): ToolId {
  return tool === "dork" || tool === "exa" || tool === "tavily" ? tool : tool === "explore" ? "tavily" : tool === "open" || tool === "propose" ? "link" : "agent";
}

/** A blocked page's reason, as the reader gave it: "blocked: crawl-delay of 12s is longer than 10s: https://…" is "crawl-delay of 12s is longer than 10s". */
const blockedWhy = (reason: string | null) => (reason ?? "blocked").replace(/^blocked: /, "").replace(/: https?:\/\/\S+$/, "");

/**
 * The code check's result from a fetch or result decision. Only a page code dropped is a failure:
 * one it couldn't read but kept as a link (blocked, a platform we never read, paywalled or marked
 * nosnippet, a lookup) is link only, and still goes to the model check. Unclear locality went on
 * to the model check too.
 */
function codeResult(row: Decision): { result: CodeResult; reason: string | null; opened: boolean } {
  const evidence = evidenceOf(row);
  const outcome = text(evidence.outcome);
  const reason = row.reason?.replace(/^kept: /, "") ?? null;
  // Runs from before the log said whether it was kept recorded only kept ones this way.
  if (row.decision === "link_only_lead") return outcome === "dropped" ? { result: "fail", reason: row.reason, opened: false } : { result: "link_only", reason: row.reason, opened: false };
  if (row.decision === "skipped") return { result: "fail", reason: `Not opened: ${row.reason ?? "skipped"}`, opened: false };
  if (outcome === "kept") {
    const checks = evidence.checks as { locality?: { outcome?: string } } | undefined;
    if (evidence.link_only === true || (evidence.link_only === undefined && evidence.rights === "link-only")) return { result: "link_only", reason, opened: !evidence.structured };
    return { result: checks?.locality?.outcome === "unclear" ? "unclear" : "pass", reason, opened: !evidence.structured };
  }
  // A page the reader was refused is kept as a link-only lead.
  if (outcome === "blocked") return { result: "link_only", reason: blockedWhy(row.reason), opened: false };
  if (outcome === "failed") return { result: "fail", reason: row.reason, opened: false };
  return { result: "fail", reason: row.reason, opened: true };
}

function geminiFrom(row: Decision) {
  const evidence = evidenceOf(row);
  if (row.decision === "not_judged") return { verdict: null, reason_code: null, reason: null, evidence: null, note: row.reason, model: null };
  const verdict = row.decision === "gemini_accepted" ? "accept" as const : "reject" as const;
  // The log says "A1 Label: reason"; the source keeps the reason alone.
  const reason = row.reason?.includes(": ") ? row.reason.slice(row.reason.indexOf(": ") + 2) : row.reason;
  return { verdict, reason_code: text(evidence.reason_code), reason, evidence: text(evidence.quote), note: null, model: row.model ?? null };
}

function stageOf(row: Pick<PageRow, "code" | "gemini" | "opened">): PageStage {
  if (row.gemini?.verdict === "reject") return "gemini_reject";
  if (row.gemini?.verdict === "accept" && row.code.result !== "fail") return "passed";
  if (row.code.result === "fail") return "code_fail";
  return row.opened.reader || row.code.result === "pass" || row.code.result === "unclear" ? "opened" : "found";
}

type Draft = Omit<PageRow, "stage" | "disagrees" | "decision" | "status">;

/** What a found page's skip reason is worked out from: the pages the run checked, what is on the map, and the agent's record. */
export type SkipFacts = { rows: Draft[]; sources: Array<Pick<RowSource, "url" | "name">>; agent: AgentState | null };
const onHost = (host: string, url: string | null | undefined) => Boolean(host) && hostOf(url) === host;
const withoutQuery = (url: string) => keyOf(url).replace(/[?#].*$/, "");

/**
 * Why a page the agent's tools turned up wasn't opened, or null when nothing recorded says. Code's
 * facts come first, in this order: the never-read list, another address for a page already in the
 * run, already on the source map, a site rejected this run, a site that couldn't be read this run,
 * a site already opened or proposed this run, a site on the map. Then the agent's own few words, then two weaker readings of the record:
 * its category was already covered when it came up, or the run ended soon after.
 */
export function skipReason(lead: Lead, facts: SkipFacts): { by: "code" | "agent"; why: string } | null {
  const host = hostOf(lead.url);
  const code = (why: string) => ({ by: "code" as const, why });
  const blocked = DO_NOT_SCRAPE.find((item) => host === item || host.endsWith(`.${item}`));
  if (blocked) return code(`on the never-read list (${blocked})`);
  const bare = withoutQuery(lead.url);
  const twin = facts.rows.find((row) => row.key !== keyOf(lead.url) && withoutQuery(row.url) === bare);
  if (twin) return code(`another address for ${twin.url}, already in this run`);
  if (facts.sources.some((source) => source.url && keyOf(source.url) === keyOf(lead.url))) return code("already on the source map");
  const checked = facts.rows.filter((row) => onHost(host, row.url) && (row.opened.reader || row.code.result !== "not_opened"));
  const rejected = checked.find((row) => row.code.result === "fail" || row.gemini?.verdict === "reject")
    ?? (facts.agent?.rejected ?? []).map((item) => ({ url: item.url, reason: item.reason })).find((item) => onHost(host, item.url));
  if (rejected) {
    const why = "code" in rejected ? rejected.gemini?.verdict === "reject" ? `the model check: ${rejected.gemini.reason ?? rejected.gemini.reason_code ?? "rejected"}` : rejected.code.reason : rejected.reason;
    return code(`same site as ${host}, rejected earlier this run${why ? ` (${clip(firstLine(why), 120)})` : ""}`);
  }
  const unreadable = checked.find((row) => row.code.result === "link_only" && !row.opened.reader);
  if (unreadable && !checked.some((row) => row.opened.reader)) return code(`same site as ${host}, which couldn't be read this run${unreadable.code.reason ? ` (${clip(firstLine(unreadable.code.reason), 120)})` : ""}`);
  const opened = checked.find((row) => row.opened.reader) ?? checked[0];
  if (opened) return code(`same site as ${host}, already ${opened.opened.reader ? "opened" : "proposed"} this run`);
  if (facts.sources.some((source) => onHost(host, source.url))) return code(`same site as ${host}, already on the source map`);
  const step = facts.agent?.steps.find((item) => item.step === lead.step);
  const check = step?.category ? facts.agent?.checklist?.[step.category] : undefined;
  const coveredEarlier = step?.category && (check?.accepted.some((item) => item.by === "map")
    || (facts.agent?.sources ?? []).some((source) => source.category === step.category && source.verdict === "accept" && source.step < lead.step));
  // The agent's own words beat the two guesses below: a covered category is often searched for more.
  if (lead.skipped?.why) return { by: lead.skipped.by ?? "agent", why: lead.skipped.why };
  if (step?.category && coveredEarlier) return code(`its category (${SECTION_LABELS[TOPIC_SECTIONS[step.category]] ?? step.category}) was already covered when it was found`);
  const last = facts.agent?.steps.at(-1)?.step ?? 0;
  const ended = facts.agent?.stopped_by?.reason ?? facts.agent?.finished?.reason ?? null;
  if (ended && lead.step >= last - 2) return code(`the run ended before the agent got to it (${clip(ended, 120)})`);
  return null;
}

type RowSource = Pick<SourceRecord, "source_id" | "url" | "name" | "section" | "status" | "review" | "gemini" | "found_by" | "review_flags">;

/**
 * Every page in a run: one row per address, built from the decision log, the agent's leads and steps, and the sources
 * (the source map, or a test-mode run's own store). With `pageDecisions` (a test-mode run), a person's decision comes by page.
 */
export function pageRows(input: { decisions: Decision[]; agent: AgentState | null; sources: RowSource[]; runId: string; pageDecisions?: Array<Pick<PageDecision, "key" | "decision" | "reason_code" | "reason">> }): PageRow[] {
  const rows = new Map<string, Draft>();
  const alias = new Map<string, string>();
  const find = (subject: string) => { const key = keyOf(subject); return rows.get(alias.get(key) ?? key) ?? null; };
  const bySource = new Map(input.sources.map((source) => [source.source_id, source]));
  const byUrl = new Map(input.sources.filter((source) => source.url).map((source) => [keyOf(source.url!), source]));
  const leads = new Map((input.agent?.leads ?? []).map((lead) => [keyOf(lead.url), lead]));
  const traced = new Map((input.agent?.sources ?? []).map((source) => [keyOf(source.url), source]));
  const blank = (url: string, at: number, tool: ToolId, how: string): Draft => ({
    key: keyOf(url), url, name: null, source_id: null, category: null, tool, found: { how, query: null, step: null },
    opened: { reader: null, why: null, fallbacks: [] }, code: { result: "not_opened", reason: null }, gemini: null, at,
  });

  // 1. Pages the code checks saw: every fixed reader's and the agent's proposals.
  for (const row of input.decisions.filter((item) => (item.stage === "fetch" || item.stage === "result") && isUrl(item.subject))) {
    const evidence = evidenceOf(row);
    const family = text(evidence.family), method = text(evidence.method);
    const tool = toolOf(family, method);
    const draft = find(row.subject) ?? blank(row.subject, row.at, tool, "");
    const lead = leads.get(draft.key), trace = traced.get(draft.key);
    // A fixed reader's page stays the fixed reader's, even when a search tool returned it later (clean-up left it out of the round).
    const fixed = tool === "fixed";
    draft.tool = lead && !fixed ? leadTool(lead.tool) : tool;
    draft.found = {
      how: tool === "fixed" ? (method ? METHOD_LABELS[method as keyof typeof METHOD_LABELS] ?? method : family ?? "Fixed reader") : lead?.tool === "open" || lead?.tool === "propose" ? `Link on ${lead.query ?? "a page"}` : tool === "agent" ? "The agent proposed this address" : family === "site_section" ? "Another section of a site that passed" : "Search",
      query: tool === "link" || tool === "fixed" ? null : lead?.query ?? text(evidence.query),
      step: fixed ? null : trace?.found_at_step ?? lead?.step ?? null,
    };
    const code = codeResult(row);
    draft.code = { result: code.result, reason: code.reason };
    const reader = text(evidence.reader);
    const fallbacks = Array.isArray(evidence.fallbacks) ? evidence.fallbacks as Array<{ reader: string; why: string }> : [];
    // Runs from before readers were recorded on every check still say the page was opened.
    draft.opened = { reader: reader ?? (code.opened ? "unrecorded" : null), why: fallbacks.length ? fallbacks.map((item) => `${item.reader}: ${item.why}`).join("; ") : code.opened && !reader ? "The reader wasn't recorded for this run" : null, fallbacks };
    if (row.topic) draft.category ??= sectionOf(row.topic);
    if (text(evidence.section)) draft.category = text(evidence.section);
    if (text(evidence.source_id)) draft.source_id = text(evidence.source_id);
    if (lead && fixed) draft.tools = ["fixed", ...leadTools(lead).filter((item) => item !== "fixed")];
    else if (lead && leadTools(lead).length > 1) draft.tools = leadTools(lead);
    rows.set(draft.key, draft);
    const sourceUrl = text(evidence.source_url);
    if (sourceUrl && keyOf(sourceUrl) !== draft.key) alias.set(keyOf(sourceUrl), draft.key);
  }

  // 2. The model check, and what was saved: matched by address, or a structured source of its own.
  for (const row of input.decisions.filter((item) => item.stage === "source")) {
    const evidence = evidenceOf(row);
    const isCheck = ["gemini_accepted", "gemini_rejected", "not_judged", "judgement_kept"].includes(row.decision);
    const saved = ["added", "proposed", "refreshed", "saved_rejected", "already_on_map"].includes(row.decision);
    if (!isCheck && !saved) continue;
    let draft = isUrl(row.subject) ? find(row.subject) : null;
    if (!draft) {
      const source = bySource.get(row.subject) ?? (isUrl(row.subject) ? byUrl.get(keyOf(row.subject)) : undefined);
      if (source) draft = [...rows.values()].find((item) => item.source_id === source.source_id) ?? null;
    }
    if (!draft) {
      // A structured source (open data, a meeting system, a national reader) is read through its own API, not opened.
      const method = text(evidence.method);
      const source = bySource.get(row.subject) ?? (isUrl(row.subject) ? byUrl.get(keyOf(row.subject)) : undefined);
      draft = blank(source?.url ?? row.subject, row.at, toolOf(null, method ?? source?.found_by.method ?? null), method ? METHOD_LABELS[method as keyof typeof METHOD_LABELS] ?? method : source?.found_by.detail ?? "");
      draft.key = isUrl(row.subject) ? keyOf(row.subject) : `source:${row.subject}`;
      draft.code = { result: "pass", reason: "A structured source: read through its own API, so not opened as a page" };
      draft.source_id = source?.source_id ?? (isUrl(row.subject) ? null : row.subject);
      if (source) draft.category = source.section;
      rows.set(draft.key, draft);
    }
    if (saved) { draft.name ??= text(evidence.name); if (row.decision === "already_on_map") draft.code.reason = `${draft.code.reason ?? ""}${draft.code.reason ? "; " : ""}${row.reason}`; continue; }
    if (row.decision === "judgement_kept") {
      const source = (draft.source_id && bySource.get(draft.source_id)) || byUrl.get(draft.key);
      const kept = source?.gemini;
      draft.gemini = kept ? { verdict: kept.verdict, reason_code: kept.reason_code, reason: kept.reason, evidence: kept.evidence, note: `Unchanged since it was judged on ${kept.at.slice(0, 10)}`, model: kept.model } : { verdict: null, reason_code: null, reason: null, evidence: null, note: row.reason, model: null };
    } else draft.gemini = geminiFrom(row);
    if (row.topic) draft.category ??= sectionOf(row.topic);
  }

  // 3. Pages the agent opened to read, without proposing them.
  for (const step of (input.agent?.steps ?? []).filter((item) => item.action === "open" && item.url && item.outcome === "ok")) {
    const key = keyOf(step.url!);
    if (rows.has(alias.get(key) ?? key)) continue;
    const lead = leads.get(key);
    const draft = blank(step.url!, step.at, lead ? leadTool(lead.tool) : "agent", lead?.tool === "open" || lead?.tool === "propose" ? `Link on ${lead.query ?? "a page"}` : lead ? "Search" : "The agent opened this address");
    draft.found = { ...draft.found, query: lead && !["open", "propose"].includes(lead.tool) ? lead.query : null, step: lead?.step ?? step.step };
    draft.opened = { reader: step.opened_with ?? "unrecorded", why: step.fallbacks?.length ? step.fallbacks.map((item) => `${item.reader}: ${item.why}`).join("; ") : step.opened_with ? null : "The reader wasn't recorded for this run", fallbacks: step.fallbacks ?? [] };
    draft.code = { result: "not_checked", reason: `Opened at step ${step.step} to read; not proposed, so not checked` };
    draft.category = sectionOf(step.category);
    rows.set(key, draft);
  }

  // 4. Everything else the agent's tools turned up, never opened, with why when the run's record says.
  const facts: SkipFacts = { rows: [...rows.values()], sources: input.sources, agent: input.agent };
  for (const lead of input.agent?.leads ?? []) {
    const key = keyOf(lead.url);
    if (rows.has(alias.get(key) ?? key)) continue;
    const step = input.agent?.steps.find((item) => item.step === lead.step);
    const draft = blank(lead.url, step?.at ?? 0, leadTool(lead.tool), lead.tool === "open" || lead.tool === "propose" ? `Link on ${lead.query ?? "a page"}` : "Search");
    draft.found = { ...draft.found, query: ["open", "propose"].includes(lead.tool) ? null : lead.query, step: lead.step };
    draft.name = lead.title || null;
    if (leadTools(lead).length > 1) draft.tools = leadTools(lead);
    const skipped = skipReason(lead, facts);
    draft.code = skipped
      ? { result: "not_opened", reason: `Not opened${skipped.by === "agent" ? " (agent)" : ""}: ${skipped.why}`, skipped_by: skipped.by }
      : { result: "not_opened", reason: "Found, not opened: the agent didn't choose it" };
    draft.category = sectionOf(step?.category ?? input.agent?.searches?.find((search) => search.step === lead.step)?.category);
    rows.set(key, draft);
  }

  const byPage = input.pageDecisions ? new Map(input.pageDecisions.map((item) => [item.key, item])) : null;
  return [...rows.values()].map((draft) => {
    const source = (draft.source_id && bySource.get(draft.source_id)) || byUrl.get(draft.key) || null;
    const review = byPage ? (source && byPage.get(pageKey(source))) || byPage.get(draft.key) : source?.review;
    // By page, a decision shows on the row even where this run didn't save the page; only a saved page can be decided here.
    const decision = source || review?.decision ? { decision: review?.decision ?? null, reason_code: review?.reason_code ?? null, reason: review?.reason ?? null } : null;
    const status = byPage && review?.decision ? review.decision === "accept" ? "active" : "rejected" : source?.status ?? null;
    const flags = source?.review_flags;
    const row: PageRow = {
      ...draft, name: draft.name ?? source?.name ?? null, source_id: source?.source_id ?? draft.source_id, category: source?.section ?? draft.category,
      decision, status, stage: "found", disagrees: Boolean(decision?.decision && draft.gemini?.verdict && decision.decision !== draft.gemini.verdict),
      flags: flags ? { strength: flags.strength, duplicate_of: flags.duplicate_of, reason: flags.reason ?? flags.note } : null,
    };
    row.stage = stageOf(row);
    return row;
  }).sort((a, b) => a.at - b.at || a.url.localeCompare(b.url));
}

/**
 * Each tool's searches, pages and acceptances, and how much of its limit it used. A page several
 * tools found counts for each of them, so the tools' totals can add up to more than the run's pages.
 * `returned` is every result the tool's searches returned (from the search log), and `found_only`
 * those no other tool or reader returned. A page a fixed reader found first counts for the fixed
 * readers only: a tool that returned it later sees it in `returned` and nowhere else. `found_elsewhere` counts its hits filed under another
 * category than the one it was searching.
 */
export function toolCounts(rows: PageRow[], searches: Partial<Record<ToolId, number>>, foundBy: Map<string, Set<ToolId>>, limits: Meter[], returned: Partial<Record<ToolId, Set<string>>> = {}, elsewhere: Partial<Record<ToolId, number>> = {}, fixture = false) {
  const use: Partial<Record<ToolId, string>> = { fixed: "Free", link: "Free", agent: "Free", ...(fixture ? { dork: "Local fixture, free", exa: "Local fixture, free", tavily: "Local fixture, free" } : {}) };
  for (const meter of limits) if (meter.tool) use[meter.tool] = `${meter.used} of ${meter.ceiling ?? "no limit"} ${meter.unit}`;
  const fixedFirst = new Set(rows.filter((row) => row.tool === "fixed").map((row) => row.key));
  return TOOL_IDS.map((tool) => {
    // A page a fixed reader found first is the fixed readers': a search tool that returned it later gets no credit for it, beyond "Results returned".
    const mine = rows.filter((row) => row.tool === tool || (row.tools?.includes(tool) && !(row.tool === "fixed" && tool !== "fixed")));
    const accepted = mine.filter((row) => row.gemini?.verdict === "accept");
    const results = [...returned[tool] ?? []];
    return {
      tool, searches: searches[tool] ?? null, found: mine.length, opened: mine.filter((row) => row.opened.reader).length,
      returned: results.length, found_only: results.filter((key) => !fixedFirst.has(key) && [...(foundBy.get(key) ?? new Set([tool]))].every((other) => other === tool)).length, found_elsewhere: elsewhere[tool] ?? 0,
      passed_code: mine.filter((row) => ["pass", "unclear", "link_only"].includes(row.code.result)).length, accepted_by_gemini: accepted.length,
      // Accepted pages no other tool or reader turned up.
      only_this_tool: accepted.filter((row) => [...(foundBy.get(row.key) ?? new Set([tool]))].every((other) => other === tool)).length,
      accepted_by_you: mine.filter((row) => row.decision?.decision === "accept").length, limit_use: use[tool] ?? "Not used",
    };
  }).filter((row) => row.found || row.searches || row.returned);
}

export type Meter = { id: string; label: string; used: number; ceiling: number | null; unit: string; note: string | null; tool: ToolId | null };

const SERVICE_LABEL = Object.fromEntries(PAID_SERVICES.map((service) => [service.id, service.label])) as Record<string, string>;

/** The limits a run used: its model calls (on whichever models served them), each search tool and paid reader it enabled, and the whole-run time. */
async function limitMeters(db: Db, run: PipelineRun, settings: RunSettings, explorations: number): Promise<Meter[]> {
  const used = new Map<string, number>();
  for (const row of await apiCalls(db).aggregate<{ _id: string; units: number }>([
    { $match: { run_id: run._id, outcome: { $in: ["ok", "failed"] } } }, { $group: { _id: "$service", units: { $sum: { $ifNull: ["$units", 1] } } } },
  ]).toArray()) {
    // Runs from before one model budget recorded Gemini and OpenAI-compatible calls apart.
    const id = (LEGACY_MODEL_SERVICES as readonly string[]).includes(row._id) ? "model" : row._id;
    used.set(id, (used.get(id) ?? 0) + row.units);
  }
  const paid = (run.options?.paid ?? {}) as Record<string, number | undefined>;
  const modelBudget = paidAllowance(paid, "model");
  // The gateway stops a service at the lower of the run's budget and its hard limit a run, so that is the ceiling.
  const budget = (service: string) => {
    const caps = [HARD_LIMITS[service]?.per_run, service === "model" ? modelBudget : paid[service]].filter((value): value is number => typeof value === "number");
    return caps.length ? Math.min(...caps) : null;
  };
  const meter = (service: string, label: string, unit: string, tool: ToolId | null, note: string | null = null): Meter => ({ id: service, label, used: used.get(service) ?? 0, ceiling: budget(service), unit, note, tool });
  const window = limitWindow(run.created_at * 1000);
  // The models that served this run's calls, whoever's keys they were on.
  const models = await db.collection(COLLECTIONS.modelUsage).distinct("model", { run_id: run._id }).catch(() => [] as unknown[]);
  const named = models.filter((model): model is string => typeof model === "string" && Boolean(model));
  // Gemini's own daily limit, shown only when this run used Gemini.
  const gemini = await apiCalls(db).countDocuments({ run_id: run._id, $or: [{ service: "gemini" }, { limit: "gemini" }] });
  const day = gemini ? await apiCalls(db).aggregate<{ units: number }>([
    { $match: { $or: [{ service: "gemini" }, { limit: "gemini" }], paid: true, outcome: { $in: ["ok", "failed"] }, created_at: { $gte: window.dayStart, $lt: window.dayStart + 86400 } } }, { $group: { _id: null, units: { $sum: { $ifNull: ["$units", 1] } } } },
  ]).toArray() : [];
  const perDay = gemini ? HARD_LIMITS.gemini?.per_day : undefined;
  const modelMeter = meter("model", named.length ? `Model calls · ${named.join(", ")}` : "Model calls", "calls", null, perDay ? `Gemini: ${day[0]?.units ?? 0} of ${perDay} on ${window.day}, across all runs` : null);
  // On Gemini, its per-run limit is the ceiling when it is lower than the run's model budget.
  const geminiRun = gemini ? HARD_LIMITS.gemini?.per_run : undefined;
  if (geminiRun !== undefined && (modelMeter.ceiling === null || geminiRun < modelMeter.ceiling)) modelMeter.ceiling = geminiRun;
  const meters = [modelMeter];
  // A local fixture run answers every search tool for free: it uses none of their services, so their meters are left out.
  const fixture = run.options?.search_provider === "fixture";
  if (settings.dork && !fixture) meters.push(meter(settings.dork_service, `Dorking · ${SERVICE_LABEL[settings.dork_service]}`, "searches", "dork"));
  if (settings.exa && !fixture) meters.push(meter("exa", "Exa", "searches", "exa"));
  if (settings.tavily && !fixture) meters.push(meter("tavily", "Tavily", "credits", "tavily", `${explorations} of ${HARD_LIMITS.tavily_explore?.per_run ?? "?"} site explorations`));
  if (settings.scrapingbee) meters.push(meter("scrapingbee", "ScrapingBee", "pages", null));
  if (settings.brightdata_open) meters.push(meter("brightdata_open", "Bright Data opening", "pages", null));
  const end = run.completed_at ?? Date.now() / 1000;
  meters.push({ id: "time", label: "Time", used: Math.max(0, Math.round((end - run.created_at) / 60)), ceiling: RUN_MINUTES, unit: "minutes", note: run.completed_at ? null : "still running", tool: null });
  return meters;
}

/** An exhaustive run's grid of category × search tool, as the agent left it. */
export function agentGrid(agent: AgentState, settings: RunSettings): Grid {
  const topics = Object.keys(agent.checklist ?? {}) as PriorityTopic[], enabled = SEARCH_TOOLS.filter((tool) => settings[tool]);
  return gridOf({ ...agent, unavailable: agent.unavailable ?? {}, sources: agent.sources ?? [] }, topics, enabled);
}

/** Why an exhaustive run stopped, in plain words. */
function exhaustiveEnding(agent: AgentState, settings: RunSettings) {
  const grid = agentGrid(agent, settings);
  const count = (status: Cell["status"]) => grid.cells.filter((cell) => cell.status === status).length;
  const cells = (n: number) => `${n} cell${n === 1 ? "" : "s"}`;
  if (agent.stopped_by) {
    const open = agent.open_cells ?? grid.open;
    return { tone: "warning", text: `Stopped at a limit: ${agent.stopped_by.reason}${open ? `, with ${cells(open)} still open` : ""}` };
  }
  if (agent.finished && grid.done) return { tone: "ok", text: count("unavailable") ? `All cells dry or unavailable: ${count("dry")} dry, ${count("unavailable")} unavailable` : "All cells dry" };
  return null;
}

/** How the run ended: goal met, dried up, which limit stopped it, or the fixed readers alone. */
export function runEnding(run: Pick<PipelineRun, "status" | "error">, settings: RunSettings, agent: AgentState | null) {
  if (["mapping"].includes(run.status)) return { tone: "running", text: "Still running" };
  if (run.status === "failed") return { tone: "failed", text: `Failed: ${run.error ?? "no reason recorded"}` };
  if (run.status === "cancelled") return { tone: "failed", text: "Cancelled" };
  if (!settings.agent) return { tone: "ok", text: "Finished: fixed readers only" };
  if (!agent) return { tone: "warning", text: "Finished: the agent left no record" };
  const exhaustive = agent.depth === "exhaustive" ? exhaustiveEnding(agent, settings) : null;
  if (exhaustive) return exhaustive;
  if (agent.stopped_by) return { tone: "warning", text: `Stopped at a limit: ${agent.stopped_by.reason}` };
  const checks = Object.entries(agent.checklist ?? {});
  const missing = checks.filter(([, check]) => check.status !== "covered").map(([topic]) => topic);
  if (agent.finished && !missing.length) return { tone: "ok", text: "Goal met: every category has an accepted source" };
  if (agent.finished && /found nothing new/.test(agent.finished.reason)) return { tone: "ok", text: `Dried up: nothing new in ${agent.dry_steps} steps; not found: ${missing.map((topic) => SECTION_LABELS[TOPIC_SECTIONS[topic as PriorityTopic]] ?? topic).join(", ")}` };
  return { tone: "warning", text: agent.finished ? `Stopped: ${agent.finished.reason}` : "Finished without a stop record" };
}

/** The agent's steps as the Agent log shows them, ending with why it stopped. */
export function agentLog(agent: AgentState | null) {
  if (!agent) return [];
  const rows: Array<{ step: string; action: string; tool: string | null; target: string | null; category: string | null; reason: string; result: string; outcome: string }> = agent.steps.map((step) => ({
    step: String(step.step), action: step.action, tool: step.tool, target: step.query ?? step.url, category: step.category ? SECTION_LABELS[TOPIC_SECTIONS[step.category]] ?? step.category : null,
    reason: step.reason, result: `${clip(firstLine(step.result), 300)}${step.accepted.length ? ` · ${step.accepted.length} accepted` : ""}`, outcome: step.outcome,
  }));
  const stop = agent.stopped_by ? `Stopped at a limit: ${agent.stopped_by.reason}` : agent.finished ? `The agent stopped: ${agent.finished.reason}` : null;
  const notFound = Object.entries(agent.checklist ?? {}).filter(([, check]) => check.status === "not_found").map(([topic, check]) => `${SECTION_LABELS[TOPIC_SECTIONS[topic as PriorityTopic]] ?? topic}: ${check.note ?? "not found"}`);
  if (stop) rows.push({ step: "Stop", action: "finished", tool: null, target: null, category: null, reason: stop, result: notFound.length ? `Not found: ${notFound.join("; ")}` : "Every category covered", outcome: "ok" });
  return rows;
}

/** An exhaustive run's grid and yield curves for the Source runs tab, or null for a run that searched until covered. */
export function searchGrid(agent: AgentState | null, settings: RunSettings, fixture = false) {
  if (!agent || agent.depth !== "exhaustive") return null;
  const grid = agentGrid(agent, settings);
  const topics = Object.keys(agent.checklist ?? {}) as PriorityTopic[];
  return {
    // A local fixture run has no caps, so its cells have no share.
    fixture, cell_dry: cellDryOf(agent).exa, cell_dry_dork: cellDryOf(agent).dork, hits: grid.hits, uncredited: grid.uncredited, open: grid.open, rounds: agent.rounds ?? 0, tool_rounds: grid.rounds,
    categories: topics.map((topic) => ({ category: topic, label: SECTION_LABELS[TOPIC_SECTIONS[topic]] ?? topic, dry: grid.dry_categories.includes(topic) })),
    cells: grid.cells,
    curves: yieldCurves(agent.searches ?? [], agent.sources ?? [], agent.start_hosts ?? []),
    // Each category's angles in order, with the agent's reason and what each tool's search on it came to. Empty for a run from before angles.
    angles: agent.angles ? angleRows(agent.angles, agent.searches ?? [], agent.sources ?? [], agent.start_hosts ?? [], topics).map((row) => ({ ...row, label: SECTION_LABELS[TOPIC_SECTIONS[row.category]] ?? row.category })) : [],
  };
}

/** Everything the Source runs tab shows for one run. */
export async function sourceRunDetail(db: Db, locationId: string, runId: string) {
  const run = await runs(db).findOne({ _id: runId, location_id: locationId, kind: "map" });
  if (!run) return null;
  const settings = settingsOf(run.options);
  const isolated = run.isolated === true;
  const [decisions, agent, sources, queries, list, byPage] = await Promise.all([
    runDecisions(db).find({ run_id: run._id }).sort({ at: 1 }).toArray(),
    db.collection<AgentState>(AGENT_STATE).findOne({ _id: run._id }),
    (isolated ? runSources(db, run._id) : sourceMap(db)).find({ location_id: locationId }, { projection: { source_id: 1, url: 1, name: 1, section: 1, status: 1, review: 1, gemini: 1, found_by: 1, review_flags: 1 } }).toArray(),
    searchQueries(db).find({ run_id: run._id, origin: "agent" }, { projection: { family: 1, skipped: 1, error: 1, "results.url": 1 } }).toArray(),
    sourceRunList(db, locationId),
    isolated ? pageDecisions(db).find({ location_id: locationId }, { projection: { key: 1, decision: 1, reason_code: 1, reason: 1 } }).toArray() : Promise.resolve(undefined),
  ]);
  const rows = pageRows({ decisions, agent, sources, runId: run._id, pageDecisions: byPage });
  const searches: Partial<Record<ToolId, number>> = {};
  const foundBy = new Map<string, Set<ToolId>>();
  for (const query of queries) {
    const tool = toolOf(query.family, "agent");
    if (!query.skipped && !query.error) searches[tool] = (searches[tool] ?? 0) + 1;
    for (const result of query.results ?? []) { const key = keyOf(result.url); foundBy.set(key, (foundBy.get(key) ?? new Set()).add(tool)); }
  }
  const returned: Partial<Record<ToolId, Set<string>>> = {};
  for (const query of queries) if (!query.skipped && !query.error) { const tool = toolOf(query.family, "agent"); for (const result of query.results ?? []) (returned[tool] ??= new Set()).add(keyOf(result.url)); }
  for (const row of rows) for (const tool of row.tools ?? [row.tool]) foundBy.set(row.key, (foundBy.get(row.key) ?? new Set()).add(tool));
  // Hits filed under another category than the one the tool was searching.
  const elsewhere: Partial<Record<ToolId, number>> = {};
  if (agent) { const grid = agentGrid(agent, settings); for (const cell of grid.cells) elsewhere[cell.tool] = (elsewhere[cell.tool] ?? 0) + Object.values(cell.found_elsewhere).reduce<number>((total, count) => total + (count ?? 0), 0); }
  const limits = await limitMeters(db, run, settings, (agent?.steps ?? []).filter((step) => step.action === "explore" && step.outcome === "ok").length);
  const stages = STAGES.map((stage) => {
    const inside = rows.filter((row) => inStage(row, stage.id));
    return { ...stage, count: inside.length, by_tool: TOOL_IDS.map((tool) => ({ tool, count: inside.filter((row) => row.tool === tool).length })).filter((item) => item.count) };
  });
  const categories = CATEGORIES.map((category) => {
    const mine = rows.filter((row) => row.category === category);
    const topic = Object.entries(TOPIC_SECTIONS).find(([, section]) => section === category)?.[0];
    const check = topic ? agent?.checklist?.[topic] : undefined;
    const accepted = mine.filter((row) => row.gemini?.verdict === "accept").length;
    return { category, label: SECTION_LABELS[category], pages: mine.length, accepted_by_gemini: accepted, accepted_by_you: mine.filter((row) => row.decision?.decision === "accept").length,
      status: accepted ? "covered" : check?.status === "not_found" ? "not_found" : "open", note: check?.status === "not_found" ? check.note : null };
  });
  const number = list.runs.find((item) => item.run_id === run._id)?.number ?? null;
  return {
    run: { id: run._id, number, location_id: run.location_id, location_name: run.location_name, status: run.status, created_at: run.created_at, completed_at: run.completed_at, error: run.error, by: run.trigger?.by ?? null, recorded: Boolean(run.options), playbook_version: run.playbook_version ?? null, isolated },
    settings, ending: runEnding(run, settings, agent), limits, stages, categories, pages: rows,
    tools: toolCounts(rows, searches, foundBy, limits, returned, elsewhere, run.options?.search_provider === "fixture"), log: agentLog(agent), grid: searchGrid(agent, settings, run.options?.search_provider === "fixture"),
  };
}
