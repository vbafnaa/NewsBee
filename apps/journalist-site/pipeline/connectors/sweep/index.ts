/**
 * Topic sweeps: Stage 2 of the agentic flow. Each priority topic runs its `after:` queries to
 * find new pages inside the window, on saved sites and elsewhere. A `trace` task then takes
 * secondary stories already collected this run and looks for the original record.
 *
 * Results are leads: each page is fetched and read, with agent extraction when no reader can
 * parse it. A blocked page stays a link-only lead with its search snippet. Useful new sites are
 * proposed back to the source map, so one-off news improves the saved map.
 */
import { addDays, httpsLink, plainText } from "../common";
import { blockedPlatform, DiscoveryBlockedError, Fetcher } from "../fetcher";
import { publicSourceTransport } from "../public-http";
import { aggregator } from "../newssearch";
import { runCollector } from "../parents/shared";
import { sha256 } from "../wider/adapters";
import { articleMeta, mainText, pageRights, readablePage, rightsAction } from "../web/page";
import { newestFirst } from "../web";
import type { CollectedEvent, Connector, ConnectorContext, DroppedItem, SourceResult, SourceTask } from "../types";
import { extractItems } from "../../agent/extract";
import { runContext, type PriorityTopic } from "../../core/run-options";
import { rangesFor } from "../../core/time";
import { TOPIC_KINDS, TOPIC_SECTIONS, buildSearchKit, stage2Queries, type PlannedQuery } from "../../discovery/topics";
import { collectedItems } from "../../editions/assemble";
import { saveText } from "../../editions/details";
import { classify } from "../../search/classifier";
import { search, type SearchResult } from "../../search/provider";
import { WEB_WINDOW } from "../../sourcemap/windows";
import { hostOf, upsertCandidates, webSourceId } from "../../sourcemap/store";
import { recordDecision } from "../../trace/decisions";

const ACCEPT_HTML = "text/html, application/xhtml+xml";
const PAGES_PER_SWEEP = 6;
const TRACES = 4;
const CASE_NUMBER = /\b(?:case|incident|docket|permit|ordinance|resolution)\s*(?:no\.?|number|#)?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i;
const AGENCY = /\b((?:[A-Z][a-z]+ )+(?:Police Department|Sheriff's Office|Fire Department|City Council|School District|Prosecutor's Office))\b/;

const SWEEP_QUERIES = 4;

/** `readHosts`: sites this run already reads as sources, which a sweep leaves to them. */
export function sweepTasks(topics: PriorityTopic[], readHosts: string[] = []): SourceTask[] {
  return [
    ...topics.map((topic): SourceTask => ({ source_id: `sweep:${topic}`, name: `Search sweep: ${topic.replace("_", " ")}`, type: "sweep", params: { topic, skip_hosts: readHosts } })),
    { source_id: "sweep:trace", name: "Tracing stories to their original records", type: "sweep", params: { trace: true } },
  ];
}

export const sweepConnector: Connector = {
  type: "sweep",
  meta: {
    name: "Search sweeps",
    formats: "Google operator searches limited to the window, per priority topic, plus tracing of secondary stories to original records. Each result is fetched and checked. Agentic runs only.",
    manual: false,
    coverage: { group: "local", label: "targeted searches" },
    storyKinds: ["home_sale", "building_permit", "game_result", "public_record"],
  },
  window: WEB_WINDOW,
  rank: newestFirst,
  sources() { return []; },
  async collect(task, context) {
    const dropped: DroppedItem[] = [];
    const collected = await runCollector(task, context, (record) => (task.params?.trace ? trace(task, context, record, dropped) : sweep(task, context, record, dropped)));
    return { ...collected, dropped };
  },
};

function discovery(context: ConnectorContext) {
  return { db: context.db, settings: context.settings, transport: context.transport, fetcher: context.fetcher, location: context.location, today: context.today, log: context.log };
}
function placeName(context: ConnectorContext) { return context.location.community?.name ?? context.location.name.split(",")[0]; }

/** Read one search result into items. A blocked page becomes a link-only lead. */
async function readResult(task: SourceTask, context: ConnectorContext, fetcher: Fetcher, result: SearchResult, query: PlannedQuery, topic: PriorityTopic | null, from: string, until: string, dropped: DroppedItem[]): Promise<CollectedEvent[]> {
  const verdict = await classify(context.settings, context.transport, { url: result.url, title: result.title, snippet: result.snippet, query: query.query, topic, place: placeName(context) });
  const kind = topic ? TOPIC_KINDS[topic] : "public_record";
  const shared = (title: string, url: string, day: string, description: string | null, extra: Partial<CollectedEvent> = {}): CollectedEvent => ({
    source_event_id: sha256(`${url}:${title}`).slice(0, 16), title, event_date: day, schedule_text: `Published ${day}`, venue: hostOf(url), room: null, source_url: url, description, kind,
    source_name: hostOf(url), needs_locality: true, section_hint: topic ? TOPIC_SECTIONS[topic] : null, source_tier: verdict.tier, found_by_query: query.query, topic, ...extra,
  } as CollectedEvent);
  let page;
  try { page = await fetcher.getResponse(result.url, 2 * 1024 * 1024, ACCEPT_HTML); }
  catch (error) {
    if (error instanceof DiscoveryBlockedError && result.date && result.date >= from && result.date <= until) return [shared(result.title, result.url, result.date, null, { link_only: true })];
    dropped.push({ source_event_id: sha256(result.url).slice(0, 16), title: result.title, url: result.url, reason: error instanceof DiscoveryBlockedError ? "blocked" : "fetch_failed" });
    return [];
  }
  const html = new TextDecoder().decode(page.body);
  const action = rightsAction(pageRights(page.headers, html));
  if (action === "skip") { dropped.push({ source_event_id: sha256(result.url).slice(0, 16), title: result.title, url: result.url, reason: "page opts out of reuse" }); return []; }
  const article = articleMeta(html);
  const text = action === "ok" ? mainText(html) : null;
  if (text) await saveText(context.db, page.url, text, { canonical_url: page.url, reuse_allowed: true });
  const day = article?.date ?? result.date ?? (text ? readablePage(html)?.date : null) ?? null;
  if (article && day && day >= from && day <= until) return [shared(article.title, page.url, day, action === "ok" ? article.description ?? plainText(text, 600) : null, action === "link-only" ? { link_only: true } : {})];
  // No reader could date this page: let the agent read it, with a verbatim quote per item.
  if (text && context.agentModel) {
    const items = await extractItems(context.agentModel, text, placeName(context), from, until).catch(() => []);
    if (items.length) {
      await recordDecision({ stage: "collect", actor: "agent", subject: page.url, decision: "extracted", reason: `${items.length} items, each with a verbatim quote`, topic, model: context.agentModel.servedModel ?? context.agentModel.model });
      return items.map((item) => shared(item.title, page.url, item.date, item.summary, { source_event_id: sha256(`${page.url}:${item.title}`).slice(0, 16), extracted_quote: item.quote, extracted_by: "agent" }));
    }
  }
  dropped.push({ source_event_id: sha256(result.url).slice(0, 16), title: article?.title ?? result.title, url: result.url, reason: day ? "outside_window" : "undated", event_date: day });
  return [];
}

async function sweep(task: SourceTask, context: ConnectorContext, record: SourceResult, dropped: DroppedItem[]) {
  const topic = task.params?.topic as PriorityTopic;
  record.feed_kind = "search";
  const ranges = rangesFor(context, WEB_WINDOW);
  const from = ranges.back?.[0] ?? addDays(context.today, -14);
  const until = topic === "events" ? ranges.ahead?.[1] ?? addDays(context.today, 14) : context.today;
  const kit = await buildSearchKit(discovery(context));
  const skipHosts = new Set((task.params?.skip_hosts as string[] | undefined) ?? []);
  const queries = stage2Queries(kit, topic, from, 20).filter(({ query }) => ![...query.matchAll(/(?:^|\s)site:(\S+)/gi)].some(([, host]) => skipHosts.has(hostOf(`https://${host}`)))).slice(0, SWEEP_QUERIES);
  const fetcher = new Fetcher(publicSourceTransport(context.transport, 15_000));
  const items: CollectedEvent[] = [];
  const seen = new Set<string>();
  const proposals: Array<{ result: SearchResult; query: PlannedQuery }> = [];
  let skipped: string | null = null;
  let read = 0;
  for (const query of queries) {
    if (context.deadline && Date.now() >= context.deadline) { record.status = "partial"; break; }
    const outcome = await search({ db: context.db, settings: context.settings, transport: context.transport, query: query.query, topic, family: query.family, stage: "stage2" });
    await recordDecision({ stage: "query", actor: "rule", subject: query.query, decision: outcome.skipped ? "skipped" : outcome.error ? "failed" : "ran", reason: outcome.skipped ?? outcome.error ?? `${outcome.results.length} results from ${outcome.provider}`, topic, evidence: { family: query.family, stage: "stage2", provider: outcome.provider } });
    if (outcome.skipped) { skipped = outcome.skipped; continue; }
    for (const result of outcome.results) {
      if (seen.has(result.url) || read >= PAGES_PER_SWEEP) continue;
      seen.add(result.url);
      if (skipHosts.has(hostOf(result.url))) continue;
      if (blockedPlatform(result.url) || aggregator(result.url)) { await recordDecision({ stage: "result", actor: "rule", subject: result.url, decision: "skipped", reason: "platform or aggregator we never read", rule: "blocked_site", topic }); continue; }
      read += 1;
      const found = await readResult(task, context, fetcher, result, query, topic, from, until, dropped);
      items.push(...found);
      if (found.length) proposals.push({ result, query });
    }
  }
  const hosts = new Set<string>();
  const candidates = proposals.flatMap(({ result, query }) => {
    const host = hostOf(result.url);
    const url = httpsLink(`https://${host}/`);
    if (!url || hosts.has(host)) return [];
    hosts.add(host);
    return [{ source_id: webSourceId(url), name: result.title.slice(0, 120) || host, url, feed_url: null, reader: "web" as const, params: { url, section: TOPIC_SECTIONS[topic], inside_area: false }, section: TOPIC_SECTIONS[topic], found_by: { method: "dork" as const, detail: `Stage 2 sweep (${topic})`, query: query.query }, inside_area: false, status: "proposed" as const, topics: [topic], why: "Had a new item in this run's window" }];
  });
  if (candidates.length) await upsertCandidates(context.db, context.location.id, candidates);
  record.status = skipped && !queries.length ? "no_feed" : "ingested";
  record.detail = skipped && !items.length ? `No search ran: ${skipped}` : `${queries.length} queries, ${read} pages read, ${items.length} items, ${candidates.length} sites proposed`;
  return items;
}

async function trace(task: SourceTask, context: ConnectorContext, record: SourceResult, dropped: DroppedItem[]) {
  record.feed_kind = "search";
  const runId = runContext()?.runId;
  const stories = await collectedItems(context.db).find({ run_id: runId, status: "collected", "facts.kind": { $in: ["news_report", "local_news"] } }, { projection: { title: 1, facts: 1 } }).limit(40).toArray();
  const fetcher = new Fetcher(publicSourceTransport(context.transport, 15_000));
  const items: CollectedEvent[] = [];
  let tried = 0;
  const ranges = rangesFor(context, WEB_WINDOW);
  const from = ranges.back?.[0] ?? addDays(context.today, -14);
  for (const story of stories) {
    if (tried >= TRACES) break;
    const text = `${story.title} ${story.facts?.description ?? ""}`;
    const handle = CASE_NUMBER.exec(text)?.[0] ?? AGENCY.exec(text)?.[1];
    if (!handle) continue;
    tried += 1;
    const query: PlannedQuery = { topic: null, family: "trace", query: `site:.gov "${handle.replace(/"/g, "")}" "${placeName(context)}"`, stage: "stage2" };
    const outcome = await search({ db: context.db, settings: context.settings, transport: context.transport, query: query.query, topic: null, family: "trace", stage: "stage2" });
    await recordDecision({ stage: "query", actor: "rule", subject: query.query, decision: outcome.skipped ? "skipped" : "ran", reason: outcome.skipped ?? `Tracing "${story.title}"`, evidence: { family: "trace", story: story.title } });
    const first = outcome.results.find((result) => /\.gov$|\.us$/.test(hostOf(result.url)));
    if (!first) continue;
    const found = await readResult(task, context, fetcher, first, query, null, from, context.today, dropped);
    for (const item of found) { item.trace_of = story.title; item.source_tier = "official"; }
    items.push(...found);
  }
  record.status = "ingested";
  record.detail = `${stories.length} secondary stories checked, ${tried} traced, ${items.length} original records found`;
  return items;
}
