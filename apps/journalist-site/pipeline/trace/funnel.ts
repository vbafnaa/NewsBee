/**
 * The run funnel behind the source map page: one record for a run from its first query to its
 * printed edition, for either flow. Each stage says what came in, what went out, who decided
 * and why. It reads the decision log, the run's own source snapshot, collected items and the
 * edition entries. Runs from before the decision log fall back to their saved edition map, and
 * what was never recorded is labelled rather than estimated.
 */
import type { Db } from "mongodb";
import { LEGACY_OPTIONS, type RunOptions } from "../core/run-options";
import { topicOfItem } from "../discovery/topics";
import { COLLECTED_ITEMS, type CollectedItem } from "../editions/assemble";
import { editionMaps } from "../editions/edition-map";
import { runs, type PipelineRun } from "../orchestration/runs";
import { searchQueries } from "../search/provider";
import { COLLECTIONS } from "../storage/mongo";
import { PRIORITY_TOPICS, PAID_SERVICES } from "../core/run-values";
import { apiCalls } from "./gateway";
import { runDecisions, type Decision } from "./decisions";

export type FunnelStage = { id: string; phase: "Find" | "Collect" | "Filter" | "Select" | "Print"; label: string; count: number | null; note: string | null; decided_by: string[]; left_out: Array<{ reason: string; count: number }>; recorded: boolean };
export type TopicCoverage = { topic: string; label: string; queries: number; sources: number; items: number; local: number; written: number; printed: number; status: string; note: string | null };

function reasonsOf<T>(rows: T[], reason: (row: T) => string | null | undefined, limit = 8) {
  const counts = new Map<string, number>();
  for (const row of rows) { const key = reason(row)?.replace(/\s*\(printed in the edition of .*\)$/, "").replace(/"[^"]*"/g, '"..."') || "no reason recorded"; counts.set(key, (counts.get(key) ?? 0) + 1); }
  return [...counts].map(([key, count]) => ({ reason: key, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}

export async function runList(db: Db, locationId: string, limit = 40) {
  const rows = await runs(db).find({ location_id: locationId }, { projection: { status: 1, created_at: 1, completed_at: 1, options: 1, edition_id: 1, published: 1 } }).sort({ created_at: -1 }).limit(limit).toArray();
  return rows.map((row) => ({ run_id: row._id, status: row.status, created_at: row.created_at, completed_at: row.completed_at, flow: row.options?.flow ?? "current", guardrails: row.options?.guardrails ?? "strict", access: row.options?.access ?? "respect", mode: row.options?.mode ?? "manual", printed: row.published?.items ?? null, recorded: Boolean(row.options) }));
}

async function costs(db: Db, run: PipelineRun) {
  const calls = await apiCalls(db).aggregate<{ _id: { service: string; outcome: string; paid: boolean }; calls: number; cost: number | null }>([
    { $match: { run_id: run._id } }, { $group: { _id: { service: "$service", outcome: "$outcome", paid: "$paid" }, calls: { $sum: 1 }, cost: { $sum: "$cost_estimate" } } },
  ]).toArray();
  const usage = await db.collection(COLLECTIONS.modelUsage).aggregate<{ _id: { provider: string; role: string }; calls: number; input: number; output: number }>([
    { $match: { run_id: run._id } }, { $group: { _id: { provider: "$provider", role: "$role" }, calls: { $sum: 1 }, input: { $sum: "$input_tokens" }, output: { $sum: "$output_tokens" } } },
  ]).toArray();
  const services = new Map<string, { service: string; label: string; paid: boolean; calls: number; failed: number; skipped: number; cost_estimate: number | null; skip_reason: string | null }>();
  for (const row of calls) {
    const entry = services.get(row._id.service) ?? { service: row._id.service, label: PAID_SERVICES.find((item) => item.id === row._id.service)?.label ?? row._id.service, paid: row._id.paid, calls: 0, failed: 0, skipped: 0, cost_estimate: null, skip_reason: null };
    if (row._id.outcome === "ok") entry.calls += row.calls;
    if (row._id.outcome === "failed") entry.failed += row.calls;
    if (row._id.outcome === "skipped") entry.skipped += row.calls;
    if (row.cost) entry.cost_estimate = (entry.cost_estimate ?? 0) + row.cost;
    services.set(row._id.service, entry);
  }
  for (const entry of services.values()) if (entry.skipped) entry.skip_reason = (await apiCalls(db).findOne({ run_id: run._id, service: entry.service, outcome: "skipped" }))?.detail ?? null;
  return { services: [...services.values()].sort((a, b) => Number(b.paid) - Number(a.paid) || b.calls - a.calls), model_usage: usage.map((row) => ({ provider: row._id.provider, role: row._id.role, calls: row.calls, input_tokens: row.input, output_tokens: row.output })) };
}

export async function runFunnel(db: Db, locationId: string, runId?: string | null) {
  const run = await runs(db).findOne({ location_id: locationId, ...(runId ? { _id: runId } : {}) }, { sort: { created_at: -1 } });
  if (!run) return null;
  const options: RunOptions = run.options ?? LEGACY_OPTIONS;
  const recorded = Boolean(run.options);
  const [decisions, queries, items, entries, draft] = await Promise.all([
    runDecisions(db).find({ run_id: run._id }).sort({ at: 1 }).toArray(),
    searchQueries(db).find({ run_id: run._id }, { projection: { results: 0 } }).toArray(),
    db.collection<CollectedItem>(COLLECTED_ITEMS).find({ run_id: run._id }, { projection: { evidence: 0, "facts.details": 0 } }).toArray(),
    db.collection(COLLECTIONS.editionEntries).find({ edition_id: run._id }, { projection: { story_id: 1, disposition: 1, section: 1, "result.validation_errors": 1, "result.error": 1 } }).toArray(),
    db.collection(COLLECTIONS.editions).findOne({ run_id: run._id }, { projection: { funnel: 1, status: 1, candidates: { $size: { $ifNull: ["$candidates", []] } } } }) as Promise<{ funnel?: Record<string, number>; status?: string; candidates?: number } | null>,
  ]);
  const legacyMap = !recorded ? await editionMaps(db).findOne({ _id: run._id }) : null;
  const by = (stage: Decision["stage"], decision?: string) => decisions.filter((row) => row.stage === stage && (!decision || row.decision === decision));
  const snapshot = run.source_snapshot ?? [];
  const queried = queries.filter((row) => !row.skipped && !row.error);
  const skippedQueries = queries.filter((row) => row.skipped);
  const failedQueries = queries.filter((row) => row.error);
  const results = by("result").length + by("fetch").length;
  const fetched = by("fetch");
  const kept = fetched.filter((row) => (row.evidence as { outcome?: string } | null)?.outcome === "kept");
  const methods = by("source").filter((row) => row.subject.startsWith("method:"));
  const candidates = by("source").filter((row) => !row.subject.startsWith("method:"));
  const read = run.sources ?? [];
  const returned = read.filter((source) => source.event_count > 0);
  const collected = items.length;
  const usable = items.filter((item) => item.status !== "dropped" || item.step !== "reader");
  const dropped = (step: string) => items.filter((item) => item.status === "dropped" && item.step === step);
  const merged = items.filter((item) => item.step === "merge");
  const heldByFloor = entries.filter((entry) => (entry.result?.validation_errors as string[] | undefined)?.includes("floor:names_withheld")).length;
  const written = entries.filter((entry) => entry.disposition === "checks_passed");
  const held = entries.filter((entry) => entry.disposition === "held");
  const printed = items.filter((item) => item.status === "published");
  const printedStories = new Set(printed.map((item) => item.story_id)).size;
  const legacy = (step: string) => legacyMap?.funnel.find((row) => row.step === step)?.count ?? null;

  const stages: FunnelStage[] = [
    { id: "methods", phase: "Find", label: "Discovery methods run", count: recorded ? methods.length : run.discovery?.length ?? null, note: !recorded ? "Not recorded for this run" : null, decided_by: ["rule"], left_out: reasonsOf(methods.filter((row) => row.decision === "failed"), (row) => row.reason), recorded },
    { id: "queries", phase: "Find", label: "Search queries run", count: options.flow === "agentic" ? queried.length : null, note: options.flow === "current" ? "Not used in this flow" : [failedQueries.length ? `${failedQueries.length} failed` : "", skippedQueries.length ? `${skippedQueries.length} could not run` : ""].filter(Boolean).join(", ") || null, decided_by: options.flow === "agentic" ? ["rule", "agent"] : [], left_out: reasonsOf([...failedQueries, ...skippedQueries], (row) => row.error ?? row.skipped), recorded },
    { id: "results", phase: "Find", label: "Search results returned", count: options.flow === "agentic" ? queried.reduce((sum, row) => sum + row.result_count, 0) : null, note: options.flow === "current" ? "Not used in this flow" : null, decided_by: options.flow === "agentic" ? ["provider"] : [], left_out: reasonsOf(by("result"), (row) => row.reason), recorded },
    { id: "fetched", phase: "Find", label: "Pages fetched and checked", count: options.flow === "agentic" ? fetched.length : null, note: options.flow === "current" ? "Not used in this flow" : `${kept.length} kept`, decided_by: options.flow === "agentic" ? ["classifier", "rule", "agent"] : [], left_out: reasonsOf(fetched.filter((row) => (row.evidence as { outcome?: string } | null)?.outcome !== "kept"), (row) => row.reason), recorded },
    { id: "candidates", phase: "Find", label: "Sources added or refreshed", count: recorded ? candidates.filter((row) => ["added", "proposed", "refreshed", "already_on_map"].includes(row.decision)).length : null, note: !recorded ? "Not recorded for this run" : null, decided_by: ["rule", "agent"], left_out: reasonsOf(candidates.filter((row) => !["added", "proposed", "refreshed", "already_on_map"].includes(row.decision)), (row) => row.reason), recorded },
    { id: "read", phase: "Collect", label: "Sources read this run", count: recorded ? read.length : legacy("sources") ?? read.length, note: null, decided_by: ["rule"], left_out: reasonsOf(snapshot.filter((source) => !source.collected), (source) => source.skip_reason), recorded: true },
    { id: "returned", phase: "Collect", label: "Sources that returned items", count: recorded ? returned.length : legacy("returning") ?? returned.length, note: null, decided_by: ["reader"], left_out: reasonsOf(read.filter((source) => !source.event_count), (source) => source.result_status === "ingested" ? "nothing in the window" : `${source.result_status ?? source.status}: ${(source.detail ?? "").slice(0, 80)}`), recorded: true },
    { id: "collected", phase: "Collect", label: "Items collected", count: collected, note: null, decided_by: ["reader", "agent"], left_out: reasonsOf(dropped("reader"), (item) => item.reason), recorded: true },
    { id: "local", phase: "Filter", label: "Kept as local", count: draft?.funnel?.local ?? legacy("local") ?? null, note: draft ? null : "Assembly has not run", decided_by: ["rule"], left_out: reasonsOf(dropped("locality"), (item) => item.reason), recorded: true },
    { id: "merged", phase: "Filter", label: "Stories after merging", count: draft?.funnel?.after_merge ?? legacy("merged") ?? null, note: null, decided_by: ["rule"], left_out: merged.length ? [{ reason: "same story from another source", count: merged.length }] : [], recorded: true },
    { id: "new", phase: "Filter", label: "Not already printed", count: draft?.funnel?.not_printed ?? legacy("new") ?? null, note: null, decided_by: ["rule"], left_out: reasonsOf(dropped("ledger"), (item) => item.reason), recorded: true },
    { id: "rated", phase: "Select", label: "Rated by the model", count: draft?.funnel?.pooled ?? null, note: null, decided_by: ["model"], left_out: reasonsOf(items.filter((item) => item.status === "not_selected" && /rule score/.test(item.reason ?? "")), (item) => item.reason), recorded: true },
    { id: "candidates_chosen", phase: "Select", label: "Candidates", count: draft?.candidates ?? legacy("candidates") ?? null, note: null, decided_by: ["model", "rule"], left_out: reasonsOf(items.filter((item) => item.status === "not_selected" && item.step === "ranking" && !/rule score/.test(item.reason ?? "")), (item) => item.reason), recorded: true },
    { id: "written", phase: "Select", label: "Written", count: entries.length, note: entries.length ? null : "Authoring has not reached this", decided_by: ["model"], left_out: [], recorded: true },
    { id: "passed", phase: "Print", label: "Passed checks", count: written.length, note: heldByFloor ? `${heldByFloor} held to protect a minor or victim, counted but not listed` : null, decided_by: ["rule"], left_out: reasonsOf(held, (entry) => ((entry.result?.validation_errors as string[] | undefined)?.join(", ") || String(entry.result?.error ?? "")).slice(0, 120)), recorded: true },
    { id: "printed", phase: "Print", label: "Printed in the edition", count: recorded ? printedStories : legacy("published") ?? printedStories, note: null, decided_by: ["rule"], left_out: reasonsOf(items.filter((item) => item.status === "not_selected" && item.step === "authoring"), (item) => item.reason), recorded: true },
  ];

  const itemsWithTopic = items.map((item) => ({ item, topic: (item.facts as { topic?: string } | null)?.topic ?? topicOfItem({ kind: item.facts?.kind, section: item.section }) }));
  const coverage: TopicCoverage[] = PRIORITY_TOPICS.map(({ id, label }) => {
    const scoped = itemsWithTopic.filter((row) => row.topic === id).map((row) => row.item);
    const decision = decisions.find((row) => row.stage === "topic" && row.subject === id);
    const sources = snapshot.filter((source) => source.topics.includes(id) || ({ crime: "safety", deaths: "obituaries", events: "events", home_sales: "real_estate", sports: "sports" } as Record<string, string>)[id] === source.section).length;
    const printedCount = new Set(scoped.filter((item) => item.status === "published").map((item) => item.story_id)).size;
    return {
      topic: id, label, queries: queries.filter((row) => row.topic === id).length, sources, items: scoped.length,
      local: scoped.filter((item) => item.status !== "dropped").length, written: new Set(scoped.filter((item) => ["candidate", "published", "held"].includes(item.status)).map((item) => item.story_id)).size, printed: printedCount,
      status: printedCount ? "printed" : scoped.length ? "collected, not printed" : decision?.decision === "not_found" ? "not found" : sources ? "no items in the window" : "no sources", note: !scoped.length && decision?.decision === "not_found" ? decision.reason : null,
    };
  });

  const rulesTripped = new Map<string, number>();
  for (const item of items) for (const rule of item.would_have_blocked ?? []) rulesTripped.set(rule, (rulesTripped.get(rule) ?? 0) + 1);
  for (const row of decisions) for (const rule of row.would_have_blocked ?? []) rulesTripped.set(rule, (rulesTripped.get(rule) ?? 0) + 1);
  const overrides = new Map<string, number>();
  for (const item of items) for (const rule of item.access_overrides ?? []) overrides.set(rule, (overrides.get(rule) ?? 0) + 1);

  const tiers = new Map<string, number>();
  for (const source of snapshot.filter((entry) => entry.collected)) tiers.set(source.tier ?? "not labelled", (tiers.get(source.tier ?? "not labelled") ?? 0) + 1);
  return {
    run: { id: run._id, location_id: run.location_id, location_name: run.location_name, status: run.status, created_at: run.created_at, completed_at: run.completed_at, edition_id: run.edition_id, error: run.error, window: run.window, recorded, transitions: run.stage_transitions ?? [], by: run.trigger.by },
    options, stages, coverage, costs: await costs(db, run), tiers: Object.fromEntries(tiers),
    rules_tripped: [...rulesTripped].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count), access_overrides: [...overrides].map(([rule, count]) => ({ rule, count })),
    agent_plans: by("query", "planned").map((row) => ({ round: row.subject, reason: row.reason, queries: (row.evidence as { queries?: string[] } | null)?.queries ?? [], planned_by: (row.evidence as { planned_by?: string } | null)?.planned_by ?? null, model: row.model ?? null })),
  };
}

/** What a funnel stage's detail lists, paged. Floor-held stories are counted, never listed. */
export async function stageDetail(db: Db, runId: string, stage: string, filters: { topic?: string | null; reason?: string | null; page?: number } = {}) {
  const page = Math.max(0, filters.page ?? 0), size = 50;
  const run = await runs(db).findOne({ _id: runId }, { projection: { sources: 1, source_snapshot: 1, discovery: 1 } });
  if (!run) return null;
  const decisionRows = async (filter: Record<string, unknown>) => (await runDecisions(db).find({ run_id: runId, ...filter, ...(filters.topic ? { topic: filters.topic } : {}) }).sort({ at: 1 }).skip(page * size).limit(size).toArray()).map((row) => ({ title: row.subject, url: /^https?:/.test(row.subject) ? row.subject : null, status: row.decision, reason: row.reason, decided_by: row.actor, topic: row.topic ?? null, flags: row.would_have_blocked ?? [], detail: row.evidence ?? null, id: String(row._id) }));
  if (stage === "methods") return { rows: await decisionRows({ stage: "source", subject: /^method:/ }), page };
  if (stage === "queries") {
    const rows = await searchQueries(db).find({ run_id: runId, ...(filters.topic ? { topic: filters.topic } : {}) }, { projection: { results: 0 } }).sort({ created_at: 1 }).skip(page * size).limit(size).toArray();
    return { rows: rows.map((row) => ({ title: row.query, url: null, status: row.skipped ? "skipped" : row.error ? "failed" : "ran", reason: row.skipped ?? row.error ?? `${row.result_count} results, ${row.sources_added} sources added${row.cached ? " (cached)" : ""}`, decided_by: row.origin === "agent" ? "agent" : "rule", topic: row.topic, flags: [], detail: { family: row.family, stage: row.stage, provider: row.provider }, id: String(row._id) })), page };
  }
  if (stage === "results") return { rows: await decisionRows({ stage: "result" }), page };
  if (stage === "fetched") return { rows: await decisionRows({ stage: "fetch" }), page };
  if (stage === "candidates") return { rows: await decisionRows({ stage: "source", subject: { $not: /^method:/ } }), page };
  if (stage === "read" || stage === "returned") {
    const list = (run.sources ?? []).filter((source) => stage === "read" || source.event_count > 0);
    const skipped = stage === "read" ? (run.source_snapshot ?? []).filter((source) => !source.collected) : [];
    const rows = [
      ...list.map((source) => ({ title: source.name, url: null, status: source.result_status ?? source.status, reason: source.detail, decided_by: "reader", topic: null, flags: [], detail: { items: source.event_count, type: source.type }, id: source.source_id })),
      ...skipped.map((source) => ({ title: source.name, url: source.url, status: "not_read", reason: source.skip_reason, decided_by: "rule", topic: null, flags: [], detail: { found_by: source.found_by }, id: source.source_id })),
    ];
    return { rows: rows.slice(page * size, (page + 1) * size), page, total: rows.length };
  }
  const itemFilter: Record<string, Record<string, unknown>> = {
    collected: {}, local: { $or: [{ status: { $ne: "dropped" } }, { step: "locality" }] }, merged: { step: "merge" }, new: { $or: [{ step: "ledger" }, { status: { $ne: "dropped" } }] },
    rated: { status: { $in: ["pooled", "candidate", "published", "held", "not_selected"] } }, candidates_chosen: { status: { $in: ["candidate", "published", "held"] } }, written: { status: { $in: ["published", "held", "candidate"] } }, passed: { status: { $in: ["published", "held"] } }, printed: { status: "published" },
  };
  const filter = { run_id: runId, ...(itemFilter[stage] ?? {}) };
  const items = await db.collection<CollectedItem>(COLLECTED_ITEMS).find(filter, { projection: { evidence: 0, "facts.details": 0 } }).sort({ status: 1, rank: 1 }).skip(page * size).limit(size).toArray();
  const rows = items.filter((item) => !(item.status === "held" && /floor:names_withheld/.test(item.reason ?? ""))).filter((item) => !filters.topic || ((item.facts as { topic?: string } | null)?.topic ?? topicOfItem({ kind: item.facts?.kind, section: item.section })) === filters.topic)
    .map((item) => ({ title: item.title, url: item.url, status: item.status, reason: item.reason, decided_by: item.step, topic: (item.facts as { topic?: string } | null)?.topic ?? topicOfItem({ kind: item.facts?.kind, section: item.section }), flags: item.would_have_blocked ?? [], detail: { section: item.section ?? null, rank: item.rank ?? null, source: item.source_name, tier: (item.facts as { source_tier?: string } | null)?.source_tier ?? null }, id: item._id }));
  return { rows, page };
}

/** One item's full path, from the query that found it to its printed text. */
export async function itemTrail(db: Db, runId: string, itemId: string) {
  const item = await db.collection<CollectedItem>(COLLECTED_ITEMS).findOne({ _id: itemId, run_id: runId });
  if (!item || (item.status === "held" && /floor:names_withheld/.test(item.reason ?? ""))) return null;
  const facts = (item.facts ?? {}) as Record<string, any>;
  const run = await runs(db).findOne({ _id: runId }, { projection: { source_snapshot: 1 } });
  const source = run?.source_snapshot?.find((entry) => entry.source_id === item.source_id);
  const urls = [item.url, source?.url].filter(Boolean) as string[];
  const decisions = await runDecisions(db).find({ run_id: runId, subject: { $in: [...urls, ...(facts.found_by_query ? [facts.found_by_query] : [])] } }).sort({ at: 1 }).toArray();
  const entry = item.story_id ? await db.collection(COLLECTIONS.editionEntries).findOne({ edition_id: runId, story_id: item.story_id }) as { disposition?: string; result?: Record<string, any> } | null : null;
  const steps: Array<{ stage: string; decided_by: string; choice: string; evidence: string | null }> = [];
  for (const row of decisions) steps.push({ stage: row.stage, decided_by: row.actor, choice: row.decision, evidence: [row.reason, row.model ? `model ${row.model}` : null].filter(Boolean).join("; ") || null });
  if (source) steps.push({ stage: "source", decided_by: source.found_by, choice: `Read as ${source.status}`, evidence: [source.detail, source.tier ? `tier ${source.tier}` : null].filter(Boolean).join("; ") });
  steps.push({ stage: "collect", decided_by: facts.extracted_by === "agent" ? "agent" : "reader", choice: "Collected", evidence: facts.extracted_quote ? `Quote: "${facts.extracted_quote}"` : item.url });
  if (item.locality) steps.push({ stage: "locality", decided_by: "rule", choice: item.step === "locality" && item.status === "dropped" ? "Left out" : "Kept", evidence: JSON.stringify(item.locality) });
  if (item.merge_group && item.step === "merge") steps.push({ stage: "merge", decided_by: "rule", choice: "Merged", evidence: item.reason });
  if (item.rank) steps.push({ stage: "rank", decided_by: "model", choice: `Number ${item.rank} in ${item.section}`, evidence: [item.why, item.score !== null && item.score !== undefined ? `score ${item.score}` : null].filter(Boolean).join("; ") });
  if (entry?.result) steps.push({ stage: "write", decided_by: entry.result.digest ? "rule" : "model", choice: entry.disposition === "held" ? "Held" : entry.result.digest ? "Digest entry" : "Written", evidence: [entry.result.validation_errors?.join(", "), entry.result.flagged_errors?.length ? `Flagged: ${entry.result.flagged_errors.join(", ")}` : null, entry.result.attempts ? `${entry.result.attempts} attempts` : null].filter(Boolean).join("; ") || null });
  steps.push({ stage: "outcome", decided_by: item.step, choice: item.status, evidence: item.reason });
  return {
    id: item._id, title: item.title, url: item.url, status: item.status, section: item.section ?? null, topic: facts.topic ?? topicOfItem({ kind: facts.kind, section: item.section }), tier: facts.source_tier ?? null, source: item.source_name,
    flags: item.would_have_blocked ?? [], access_overrides: item.access_overrides ?? [], steps,
    printed: entry?.result?.draft ? { headline: entry.result.draft.headline, summary: entry.result.draft.summary } : null,
    quotes: (entry?.result?.details?.support ?? []).slice(0, 6) as Array<{ field: string; value: string; quote: string }>,
  };
}
