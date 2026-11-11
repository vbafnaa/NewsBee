/**
 * The source map: one record per source per location, in MongoDB `source_map`. Discovery
 * writes candidates here, editors pin, pause, reject or add sources here, and collection
 * reads only from here. A record's `_id` is `<location id>:<source id>`; the source id is
 * also the collection task's id, so run results, health and the edition map line up.
 *
 * In test mode (NEWSBEE_SOURCE_RUNS_ISOLATED, off by default), a map run's jobs write their own
 * store instead, `source_run_<run id>`, with the same records: `sourceMap` returns it inside such a
 * run, so the source map and editions are untouched and each run keeps exactly what it found. A
 * person's decisions on those runs' pages are kept by page (`page_decisions`), so they carry across
 * runs, and a run that writes the source map saves a page it finds with that decision.
 */
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { LookupWindow, SourceTask, SourceType } from "../connectors/types";
import { nonScrapableReason } from "./display";
import { decisionOf, OTHER_CODES, reasonLabel, type ReasonCode } from "./reasons";
import { isolatedRunId, itemCap, limits } from "../core/run-options";
import { recordDecision } from "../trace/decisions";
import { CATEGORIES, SECTION_LABELS, type SectionId } from "./sections";
import { inheritedAccessReview, reviewAllowsCollection, type SourceAccessReview } from "./source-review";
import type { PageChecks } from "../discovery/checks";
import type { GeminiVerdict, JudgeInput } from "../discovery/gemini-check";
import type { ReviewFlags } from "../discovery/final-review";

export const SOURCE_MAP = "source_map";
/** Append-only history of human source labels. It is never updated or deleted, and outlives the source records. */
export const SOURCE_REVIEWS = "source_reviews";
export const MAX_REVIEW_REASON = 2000;
/** A source with no new item for this many runs, or failing this many runs in a row, goes dormant. */
export const DORMANT_EMPTY_RUNS = 3;
export const DORMANT_FAILURES = 3;
/** Dormant sources are retried this often. */
export const DORMANT_RETRY_DAYS = 14;
/** Sources whose last new item is older than this are greyed out on the reader page. */
export const STALE_DAYS = 21;
/** Proposed pages kept per site. */
export const PROPOSED_PER_HOST = 12;
/** Checked section pages kept per site: a city's agendas, police news and permits are different sources. */
export const SECTION_PAGES_PER_HOST = 24;

export type DiscoveryMethod =
  | "government" | "institutions" | "osm" | "meetings" | "opendata" | "newsrooms" | "athletics" | "schools" | "groups" | "publishers" | "homesales" | "llm"
  | "directories" | "dork" | "agent" | "national" | "library" | "editor" | "reader_suggestion" | "migrated";

export const METHOD_LABELS: Record<DiscoveryMethod, string> = {
  government: "City or county website",
  directories: "Official institution directory",
  institutions: "Local institution website, read and checked",
  osm: "OpenStreetMap place inside the area",
  meetings: "Meeting platform account",
  opendata: "Open-data portal",
  newsrooms: "Wikidata newsroom nearby",
  athletics: "State athletic association (Wikidata)",
  schools: "School district directory and school websites",
  groups: "Local group or funeral home website, then checked",
  publishers: "Publisher found by news search",
  homesales: "Home sale data (ATTOM)",
  llm: "Suggested by a model, then checked",
  dork: "Google operator search, then checked",
  agent: "Found by the mapping agent, then checked",
  national: "National public data",
  library: "Library directory",
  editor: "Added by an editor",
  reader_suggestion: "Suggested by a reader",
  migrated: "Earlier source link",
};

/**
 * `proposed` sources wait, and no edition reads them: a source the model check couldn't judge, or,
 * while proposed-until-approved is on, every source a map run finds, until a person accepts it. With
 * it off (the default), a source the model check accepted goes on `active`.
 * `rejected` is a person's rejection, or the model check's (`gemini.verdict`), which a person can overrule.
 */
export type SourceStatus = "active" | "pinned" | "paused" | "rejected" | "dormant" | "proposed";
export type SourceTier = "official" | "organisation" | "business" | "local_reporting" | "repost";
/** The widest area a source covers. Items from a wider source still have to pass the locality filter. */
export type SourceScope = "place" | "city" | "county" | "state";
export type SourceEvidence = { url: string; quote: string | null; kind: "locality" | "date" | "search"; at: number };
/** What was checked before a source was used, and any rule a relaxed run skipped. */
export type SourceAccess = { robots: "allowed" | "ignored" | "blocked"; rights: string; terms: "not_checked" | "no_restriction_found" | "mentions_restrictions" | "skipped"; checked_at: number; fresh: boolean };

export type SourceDecision = "accept" | "reject";
/**
 * A person's label. `initial_status` is captured at the first label and never overwritten. `reason` is
 * the text for an Other code; under any other code, or none, it is a free-text note from before codes.
 */
export type SourceReview = { decision: SourceDecision | null; reason_code?: ReasonCode | null; reason: string | null; initial_status: SourceStatus; by: string; at: string };
/** One row of `source_reviews`: what was labelled, as it looked at that moment. */
export type SourceReviewEntry = Pick<SourceRecord, "location_id" | "source_id" | "url" | "name" | "section"> & SourceReview & {
  source_tier: SourceTier | null; scope: SourceScope | null; source_kind: string | null;
  found_by: SourceRecord["found_by"]; status: SourceStatus; link_only: boolean; non_scrapable_reason: string | null; reason_label: string | null;
};

export type SourceHealth = {
  last_run_at: number | null;
  last_status: string | null;
  last_detail: string | null;
  runs: number;
  items_found: number;
  items_local: number;
  items_published: number;
  consecutive_failures: number;
  empty_runs: number;
  last_new_item_day: string | null;
  skip_reason: string | null;
};

export type SourceRecord = {
  _id: string;
  location_id: string;
  source_id: string;
  name: string;
  url: string | null;
  feed_url?: string | null;
  reader: SourceType;
  params: Record<string, unknown>;
  section: SectionId;
  /**
   * How it was found. `opened_with` is the reader that opened its page. A source added by hand can carry `how_found`. The agent also records the tool that found it, the step
   * it proposed it at (`step`), the step the page first came up (`found_at_step`) and its stated reason.
   */
  found_by: { method: DiscoveryMethod; detail: string; query?: string | null; opened_with?: string | null; tool?: string | null; step?: number | null; found_at_step?: number | null; reason?: string | null;
    /** A person's own note on how they found a source they added by hand, so their research habits can go into the playbook. */
    how_found?: string | null };
  source_tier?: SourceTier | null;
  evidence?: SourceEvidence[];
  access?: SourceAccess | null;
  why?: string | null;
  topics?: string[];
  agent_run_id?: string | null;
  access_overrides?: string[];
  scope?: SourceScope;
  /** How it publishes: feed, calendar, dataset, document_list, listing or lookup. */
  source_kind?: string;
  latest_day?: string | null;
  /** The locality and freshness facts discovery's checks saw, each with its outcome. */
  checks?: PageChecks;
  /** The model check's verdict, reason code and evidence, or why it wasn't judged. */
  gemini?: GeminiVerdict;
  /** The newest item titles discovery saw, for the final review's duplicate check. */
  recent_titles?: string[];
  /** The final review's flags: how strong the source is, and a likely duplicate. Flags only. */
  review_flags?: ReviewFlags;
  /** Items from a source inside the area are local by construction. */
  inside_area: boolean;
  /** Listed with a link only (court portals, public notices): never collected. */
  link_only?: boolean;
  status: SourceStatus;
  note?: string | null;
  review?: SourceReview;
  window?: LookupWindow | null;
  health: SourceHealth;
  score: number;
  first_seen: string;
  last_seen: string;
  dormant_until?: string | null;
  access_review?: SourceAccessReview;
};

export type SourceCandidate = Omit<SourceRecord, "_id" | "location_id" | "status" | "health" | "score" | "first_seen" | "last_seen" | "note" | "dormant_until" | "review" | "review_flags"> & {
  status?: SourceStatus; note?: string | null;
  /** A checked section of a site, not a second copy of its home page. Not saved. */
  section_page?: boolean;
  /** What the model check reads of the page. Not saved. */
  judge_input?: JudgeInput;
  /** The status its route gave it, before the save step held it as proposed. Not saved. */
  route_status?: SourceStatus;
};

/** A source whose status is still the pipeline's to set: proposed, or made active or rejected by the model check, and not labelled by a person. */
export function checkOwned(record: Pick<SourceRecord, "status" | "review" | "gemini">) {
  return !record.review?.decision && (record.status === "proposed" || (record.status === "rejected" && record.gemini?.verdict === "reject") || (record.status === "active" && record.gemini?.verdict === "accept"));
}

/** The source map, or, inside a test-mode map run, that run's own store. */
export function sourceMap(db: Db) {
  const runId = isolatedRunId();
  return runId ? runSources(db, runId) : db.collection<SourceRecord>(SOURCE_MAP);
}

/** A test-mode run's own sources: the records it would have written to the source map. Never read by an edition. */
export function runSources(db: Db, runId: string) {
  return db.collection<SourceRecord>(`source_run_${runId}`);
}

/**
 * A person's decision on a page, for a location and the page's normalised address (`key`), so a page
 * reviewed in one source run shows that decision in every run. Each save also goes to
 * `source_reviews`, whose labels are the model check's examples.
 */
export const PAGE_DECISIONS = "page_decisions";
export type PageDecision = { _id: string; location_id: string; key: string; url: string | null; name: string | null; section: SectionId | null; source_id: string | null;
  decision: SourceDecision | null; reason_code: ReasonCode | null; reason: string | null; by: string; at: string; run_id: string | null };
export function pageDecisions(db: Db) { return db.collection<PageDecision>(PAGE_DECISIONS); }
/** The key a page's decision is kept under: its normalised address, or its source id for a structured source. */
export function pageKey(record: Pick<SourceRecord, "url" | "source_id">) { return record.url ? normaliseUrl(record.url) : `source:${record.source_id}`; }

/**
 * The accept or reject a person gave each of these pages in a test-mode run, by source id. Read only
 * by a run that writes the source map, so those decisions stand there: an accepted page goes on the
 * map accepted, a rejected one rejected, and neither is judged again.
 */
export async function earlierPageDecisions(db: Db, locationId: string, records: Array<Pick<SourceRecord, "url" | "source_id">>) {
  if (isolatedRunId() || !records.length) return new Map<string, PageDecision>();
  const ids = new Map(records.map((record) => [`${locationId}:${pageKey(record)}`, record.source_id]));
  const found = await pageDecisions(db).find({ _id: { $in: [...ids.keys()] }, decision: { $in: ["accept", "reject"] } }).toArray();
  return new Map(found.map((decision) => [ids.get(decision._id)!, decision]));
}

async function keepPageDecision(db: Db, locationId: string, record: Pick<SourceRecord, "url" | "source_id" | "name" | "section">, review: SourceReview, runId: string | null) {
  const key = pageKey(record);
  await pageDecisions(db).replaceOne({ _id: `${locationId}:${key}` }, {
    location_id: locationId, key, url: record.url, name: record.name, section: record.section, source_id: record.source_id,
    decision: review.decision, reason_code: review.reason_code ?? null, reason: review.reason, by: review.by, at: review.at, run_id: runId,
  }, { upsert: true });
}

/**
 * Saves a person's decision on a page a test-mode run found, as `saveSourceReview` does for the
 * source map and with the same rules for codes and text, but by page: the run's own record and the
 * source map are left as they are. Returns the status the page would have with this decision.
 */
export async function savePageDecision(db: Db, locationId: string, runId: string, sourceId: string, change: ReviewChange, by: string) {
  const record = await runSources(db, runId).findOne({ _id: `${locationId}:${sourceId}` });
  if (!record) throw new Error(`Unknown source: ${sourceId}`);
  const previous = await pageDecisions(db).findOne({ _id: `${locationId}:${pageKey(record)}` });
  const decision = change.decision !== undefined ? change.decision : previous?.decision ?? null;
  const code = previous?.reason_code ?? null;
  const nextCode = change.reason_code !== undefined ? change.reason_code : change.decision !== undefined ? previous?.decision === change.decision ? code : null : code;
  if (nextCode && decisionOf(nextCode) !== decision) throw new Error("Invalid reason code: it doesn't belong to this source's decision");
  const reason = change.reason !== undefined ? change.reason : code && OTHER_CODES.includes(code) && code !== nextCode ? null : previous?.reason ?? null;
  const review: SourceReview = { decision, reason_code: nextCode, reason, initial_status: record.status, by, at: new Date().toISOString() };
  await keepPageDecision(db, locationId, record, review, runId);
  const status: SourceStatus = decision === "reject" ? "rejected" : decision === "accept" ? "active" : record.status;
  await db.collection<SourceReviewEntry>(SOURCE_REVIEWS).insertOne({
    location_id: locationId, source_id: sourceId, url: record.url, name: record.name, section: record.section,
    source_tier: record.source_tier ?? null, scope: record.scope ?? null, source_kind: record.source_kind ?? null,
    found_by: record.found_by, status, link_only: record.link_only ?? false, non_scrapable_reason: nonScrapableReason(record), ...review, reason_label: reasonLabel(review.reason_code),
  });
  return { status, review };
}

/** One decision for many of a test-mode run's pages, each saved on its own, as `saveSourceReviews` does. */
export async function savePageDecisions(db: Db, locationId: string, runId: string, sourceIds: string[], change: ReviewChange, by: string) {
  const saved: Array<{ source_id: string; status: SourceStatus; review: SourceReview }> = [];
  const failed: Array<{ source_id: string; detail: string }> = [];
  for (const sourceId of [...new Set(sourceIds)]) {
    try { saved.push({ source_id: sourceId, ...await savePageDecision(db, locationId, runId, sourceId, change, by) }); }
    catch (error) { failed.push({ source_id: sourceId, detail: error instanceof Error ? error.message : String(error) }); }
  }
  return { saved, failed };
}

export async function ensureSourceMapIndexes(db: Db) {
  await sourceMap(db).createIndexes([{ key: { location_id: 1, section: 1 } }, { key: { location_id: 1, status: 1 } }]);
  await db.collection<SourceReviewEntry>(SOURCE_REVIEWS).createIndexes([{ key: { location_id: 1, source_id: 1, at: 1 } }]);
}

/** Normalised URL used to key and de-duplicate web sources: host without www, path without trailing slash. */
export function normaliseUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
export function hostOf(url: string | null | undefined) {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}
export function webSourceId(url: string) {
  return `web:${createHash("sha256").update(normaliseUrl(url)).digest("hex").slice(0, 12)}`;
}
export function hashId(prefix: string, value: string) {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export function emptyHealth(): SourceHealth {
  return { last_run_at: null, last_status: null, last_detail: null, runs: 0, items_found: 0, items_local: 0, items_published: 0, consecutive_failures: 0, empty_runs: 0, last_new_item_day: null, skip_reason: null };
}

export type CategoryCoverage = { category: SectionId; label: string; found: number; readable: number; link_only: number; built_in: number; empty: boolean };

/**
 * How many sources each category has. `found` counts what discovery found for this place;
 * `built_in` counts the national readers every place gets, so they can't hide an empty category.
 */
export async function categoryCoverage(db: Db, locationId: string): Promise<CategoryCoverage[]> {
  const rows = await sourceMap(db).find({ location_id: locationId, status: { $nin: ["rejected", "paused"] } }, { projection: { section: 1, link_only: 1, "found_by.method": 1 } }).toArray();
  return CATEGORIES.map((category) => {
    const inCategory = rows.filter((row) => row.section === category);
    const found = inCategory.filter((row) => !["national", "library"].includes(row.found_by.method));
    const linkOnly = found.filter((row) => row.link_only).length;
    return { category, label: SECTION_LABELS[category], found: found.length, readable: found.length - linkOnly, link_only: linkOnly, built_in: inCategory.length - found.length, empty: !found.length };
  });
}

/**
 * Write discovery candidates for a location. New sources are added with the status they carry
 * (active when none); existing ones keep their editor status, note, review and health, and get
 * fresh details. A source a person labelled keeps its label, and one a person rejected stays
 * rejected. The pipeline still sets the status of what is its own (proposed, or rejected by the
 * Model check): a new verdict can reject it, make it active when the check accepted it (see
 * `applyStanding`), or lift the check's own rejection back to proposed. Returns how many were new.
 */
export async function upsertCandidates(db: Db, locationId: string, candidates: SourceCandidate[]) {
  const now = new Date().toISOString();
  let added = 0;
  const seenHosts = new Map<string, number>();
  const earlier = await earlierPageDecisions(db, locationId, candidates);
  for (const candidate of candidates) {
    const _id = `${locationId}:${candidate.source_id}`;
    const existing = await sourceMap(db).findOne({ _id }, { projection: { status: 1, found_by: 1, review: 1, gemini: 1 } });
    const owned = Boolean(existing && checkOwned(existing));
    // A person's decision on this page in a test-mode run stands, unless the map already has a label or a pin.
    const decided = !existing?.review?.decision && existing?.status !== "pinned" ? earlier.get(candidate.source_id) : undefined;
    // A checked page's id follows its feed, which can come and go. A page a person rejected stays out under either id.
    if (!existing && candidate.section_page && candidate.source_kind && await sourceMap(db).findOne({ location_id: locationId, url: candidate.url, status: "rejected", $or: [{ "review.decision": "reject" }, { "gemini.verdict": { $ne: "reject" } }] }, { projection: { _id: 1 } })) {
      await recordDecision({ stage: "source", actor: "rule", subject: candidate.url ?? candidate.source_id, decision: "not_added", reason: "This page was rejected under another address", rule: "rejected_page" });
      continue;
    }
    // A web source already on the map under another URL on the same host is not added twice.
    if (!existing && candidate.reader === "web" && candidate.url) {
      const host = hostOf(candidate.url);
      const count = seenHosts.get(host) ?? await sourceMap(db).countDocuments({ location_id: locationId, reader: "web", url: { $regex: `^https://(www\\.)?${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)` } });
      seenHosts.set(host, count + 1);
      // Agentic finds are specific pages, and one site can have many worth reading.
      const specificPage = Boolean(candidate.source_kind && candidate.params.discovery_parent_url);
      const cap = candidate.section_page ? itemCap(SECTION_PAGES_PER_HOST) : (candidate.route_status ?? candidate.status) === "proposed" || specificPage ? itemCap(PROPOSED_PER_HOST) : limits().newWebPerHost;
      if (candidate.status !== "pinned" && count >= cap) { await recordDecision({ stage: "source", actor: "rule", subject: candidate.url, decision: "not_added", reason: `${count} sources from ${host} are already on the map`, rule: "per_host_limit", topic: candidate.topics?.[0] ?? null }); continue; }
    }
    // A proposal never changes a source already on the map that isn't the pipeline's own: a person's label, and current runs' baseline, stand.
    if (existing && !owned && !decided && (candidate.status === "proposed" || candidate.status === "rejected")) {
      await sourceMap(db).updateOne({ _id }, { $set: { last_seen: now }, $addToSet: { topics: { $each: candidate.topics ?? [] } } });
      await recordDecision({ stage: "source", actor: candidate.found_by.method === "agent" ? "agent" : "rule", subject: candidate.url ?? candidate.source_id, decision: "already_on_map", reason: `Already on the map as ${existing.status}`, topic: candidate.topics?.[0] ?? null, evidence: { method: candidate.found_by.method, query: candidate.found_by.query ?? null, name: candidate.name } });
      continue;
    }
    const keepFoundBy = existing && ["editor", "reader_suggestion"].includes(existing.found_by?.method);
    const set: Partial<SourceRecord> = {
      location_id: locationId, source_id: candidate.source_id, name: candidate.name, url: candidate.url, feed_url: candidate.feed_url ?? null,
      reader: candidate.reader, params: candidate.params, section: candidate.section, inside_area: candidate.inside_area,
      link_only: candidate.link_only ?? false, window: candidate.window ?? null, last_seen: now,
      ...(keepFoundBy ? {} : { found_by: candidate.found_by }),
      ...(candidate.source_tier ? { source_tier: candidate.source_tier } : {}), ...(candidate.evidence ? { evidence: candidate.evidence } : {}),
      ...(candidate.access ? { access: candidate.access } : {}), ...(candidate.why ? { why: candidate.why } : {}),
      ...(candidate.topics ? { topics: candidate.topics } : {}), ...(candidate.agent_run_id ? { agent_run_id: candidate.agent_run_id } : {}),
      ...(candidate.access_overrides?.length ? { access_overrides: candidate.access_overrides } : {}),
      ...(candidate.scope ? { scope: candidate.scope } : {}), ...(candidate.source_kind ? { source_kind: candidate.source_kind } : {}),
      ...(candidate.latest_day ? { latest_day: candidate.latest_day } : {}), ...(candidate.checks ? { checks: candidate.checks } : {}),
      // A check that couldn't judge it doesn't wipe the accept a source the check made active stands on.
      ...(candidate.gemini && !(owned && existing!.status === "active" && candidate.gemini.verdict === null) ? { gemini: candidate.gemini } : {}), ...(candidate.recent_titles?.length ? { recent_titles: candidate.recent_titles } : {}),
    };
    // The pipeline's own source: the check can reject it, or lift its own rejection back to proposed.
    const status = decided ? decided.decision === "accept" ? "active" : "rejected"
      : owned ? candidate.status === "rejected" ? "rejected" : candidate.status === "active" && candidate.gemini?.verdict === "accept" ? "active" : existing!.status === "rejected" ? "proposed" : existing!.status : null;
    const review: SourceReview | null = decided ? { decision: decided.decision, reason_code: decided.reason_code, reason: decided.reason, initial_status: existing?.status ?? candidate.status ?? "active", by: decided.by, at: decided.at } : null;
    await sourceMap(db).updateOne({ _id }, {
      $set: { ...set, ...(status ? { status } : {}), ...(review ? { review } : {}) },
      $setOnInsert: { ...(status ? {} : { status: candidate.status ?? "active" }), note: candidate.note ?? null, health: emptyHealth(), score: 0, first_seen: now, dormant_until: null },
    }, { upsert: true });
    if (!existing) added += 1;
    await recordDecision({ stage: "source", actor: candidate.found_by.method === "agent" ? "agent" : "rule", subject: candidate.url ?? candidate.source_id, decision: decided ? `person_${decided.decision === "accept" ? "accepted" : "rejected"}` : existing ? "refreshed" : candidate.status === "proposed" ? "proposed" : candidate.status === "rejected" ? "saved_rejected" : "added", reason: decided ? `A person ${decided.decision === "accept" ? "accepted" : "rejected"} this page in an earlier run` : candidate.why ?? candidate.found_by.detail, topic: candidate.topics?.[0] ?? null, evidence: { method: candidate.found_by.method, query: candidate.found_by.query ?? null, tier: candidate.source_tier ?? null, name: candidate.name } });
  }
  return added;
}

/** Collect only due, readable sources that pass the applicable access review. */
export async function collectableSources(db: Db, locationId: string, today: string, flow: "current" | "agentic" = "current", options: { proposedUntilApproved?: boolean } = {}) {
  const proposed = flow === "agentic" && options.proposedUntilApproved === false;
  const statuses = proposed ? ["active", "pinned", "dormant", "proposed"] : ["active", "pinned", "dormant"];
  const records = await reviewedLocationSources(db, locationId);
  return records.filter((record) => statuses.includes(record.status) && !record.link_only
    && reviewAllowsCollection(record.access_review, today)
    && (record.status !== "dormant" || !record.dormant_until || record.dormant_until <= today))
    .sort((a, b) => Number(b.status === "pinned") - Number(a.status === "pinned") || b.score - a.score || a.name.localeCompare(b.name));
}

/** Reconcile aliases at planning, execution and assembly, including tasks queued before review. */
export async function reviewedLocationSources(db: Db, locationId: string) {
  const records = await sourceMap(db).find({ location_id: locationId }).toArray();
  const reviewed = records.filter((record) => record.access_review);
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const inherited = inheritedAccessReview(record, reviewed);
    if (!inherited) continue;
    const changes = { access_review: inherited, status: record.status === "rejected" ? "rejected" as const : "paused" as const, link_only: true };
    await sourceMap(db).updateOne({ _id: record._id, access_review: { $exists: false } }, { $set: changes });
    records[index] = { ...record, ...changes };
  }
  return records;
}

export function taskFor(record: SourceRecord): SourceTask {
  if (!reviewAllowsCollection(record.access_review, new Date().toISOString().slice(0, 10))) throw new Error(`Source access review prevents collection: ${record.access_review?.reason}`);
  return { type: record.access_review?.collection_reader ?? record.reader, source_id: record.source_id, name: record.name, params: { ...record.params,
    ...record.access_review?.collection_params, ...(record.access_review ? { images_allowed: record.access_review.images_allowed } : {}),
    source_map_id: record._id, ...(record.source_tier ? { source_tier: record.source_tier } : {}), ...(record.window ? { window: record.window } : {}) } };
}

/** Records the outcome of one collection on the source's health, and moves it in or out of dormancy. */
export async function recordSourceRun(db: Db, locationId: string, sourceId: string, outcome: { status: string; detail: string | null; found: number; local: number; newestDay: string | null; today: string }) {
  const _id = `${locationId}:${sourceId}`;
  const record = await sourceMap(db).findOne({ _id });
  if (!record) return null;
  const failed = ["failed", "blocked"].includes(outcome.status);
  // Running out of time or needing a map run says nothing about the source itself.
  const neutral = ["partial", "needs_remap"].includes(outcome.status);
  const health: SourceHealth = {
    ...emptyHealth(), ...record.health,
    last_run_at: Date.now() / 1000, last_status: outcome.status, last_detail: outcome.detail,
    runs: (record.health?.runs ?? 0) + 1,
    items_found: (record.health?.items_found ?? 0) + outcome.found,
    items_local: (record.health?.items_local ?? 0) + outcome.local,
    consecutive_failures: failed ? (record.health?.consecutive_failures ?? 0) + 1 : neutral ? record.health?.consecutive_failures ?? 0 : 0,
    empty_runs: !failed && !neutral && outcome.found === 0 ? (record.health?.empty_runs ?? 0) + 1 : failed || (neutral && outcome.found === 0) ? record.health?.empty_runs ?? 0 : 0,
    last_new_item_day: outcome.newestDay && (!record.health?.last_new_item_day || outcome.newestDay > record.health.last_new_item_day) ? outcome.newestDay : record.health?.last_new_item_day ?? null,
    skip_reason: outcome.status === "blocked" ? outcome.detail : null,
  };
  let status = record.status;
  let dormantUntil = record.dormant_until ?? null;
  // A source a person accepted stays active: only a person changes that label.
  if (["active", "dormant"].includes(record.status) && record.review?.decision !== "accept") {
    if (health.consecutive_failures >= DORMANT_FAILURES || health.empty_runs >= DORMANT_EMPTY_RUNS) {
      status = "dormant";
      const until = new Date(`${outcome.today}T00:00:00Z`);
      until.setUTCDate(until.getUTCDate() + DORMANT_RETRY_DAYS);
      dormantUntil = until.toISOString().slice(0, 10);
    } else if (record.status === "dormant" && outcome.local > 0) {
      status = "active";
      dormantUntil = null;
    }
  }
  const score = Math.round((health.items_local * 2 + health.items_published * 5) / Math.max(1, health.runs) * 10) / 10;
  await sourceMap(db).updateOne({ _id }, { $set: { health, score } });
  // Only when the status moved, and only from the one read above, so a label made during the run stands.
  if (status !== record.status) await sourceMap(db).updateOne({ _id, status: record.status }, { $set: { status, dormant_until: dormantUntil } });
  else if (dormantUntil !== (record.dormant_until ?? null)) await sourceMap(db).updateOne({ _id, status }, { $set: { dormant_until: dormantUntil } });
  return { ...record, health, status, score };
}

export async function recordPublishedCounts(db: Db, locationId: string, counts: Map<string, number>) {
  for (const [sourceId, count] of counts) {
    await sourceMap(db).updateOne({ _id: `${locationId}:${sourceId}` }, { $inc: { "health.items_published": count } });
  }
}

export async function setSourceStatus(db: Db, locationId: string, sourceId: string, status: SourceStatus, note?: string | null) {
  if (["active", "pinned", "dormant"].includes(status)) {
    await reviewedLocationSources(db, locationId);
    const source = await sourceMap(db).findOne({ _id: `${locationId}:${sourceId}` });
    if (!source) throw new Error(`Unknown source: ${sourceId}`);
    if (!reviewAllowsCollection(source.access_review, new Date().toISOString().slice(0, 10))) {
      throw new Error(`Invalid source access review: ${source.access_review?.reason}. Update the review before enabling collection.`);
    }
  }
  const set: Record<string, unknown> = { status, ...(note !== undefined ? { note } : {}) };
  if (status !== "dormant") set.dormant_until = null;
  const result = await sourceMap(db).updateOne({ _id: `${locationId}:${sourceId}` }, { $set: set });
  if (!result.matchedCount) throw new Error(`Unknown source: ${sourceId}`);
}

/**
 * Saves a person's label and appends it to `source_reviews`. Send only what changed: a decision
 * moves the live status, and clearing it (null) restores the initial status; a reason alone
 * leaves the status alone. A changed decision clears the reason code, and leaving an Other code clears
 * its text; a note from before codes stays. The history row comes last, so a failed save can simply be
 * sent again.
 */
export async function saveSourceReview(db: Db, locationId: string, sourceId: string, change: { decision?: SourceDecision | null; reason_code?: ReasonCode | null; reason?: string | null }, by: string) {
  const at = new Date().toISOString();
  const _id = `${locationId}:${sourceId}`;
  const decision = { $ifNull: ["$review.decision", null] };
  const code = { $ifNull: ["$review.reason_code", null] };
  const nextCode = change.reason_code !== undefined ? { $literal: change.reason_code } : change.decision !== undefined ? { $cond: [{ $eq: [decision, { $literal: change.decision }] }, code, null] } : code;
  // A code sent alone must suit the stored decision. Checking it in the write means a decision saved at the same moment can't slip past.
  const matches = change.reason_code && change.decision === undefined ? { "review.decision": decisionOf(change.reason_code) } : {};
  // One atomic write, so a reason and a decision saved together can't lose each other. $literal keeps "$..." text as text.
  const record = await sourceMap(db).findOneAndUpdate({ _id, ...matches }, [{ $set: {
    "review.initial_status": { $ifNull: ["$review.initial_status", "$status"] },
    "review.decision": change.decision !== undefined ? { $literal: change.decision } : { $ifNull: ["$review.decision", null] },
    "review.reason_code": nextCode,
    "review.reason": change.reason !== undefined ? { $literal: change.reason } : { $cond: [{ $and: [{ $in: [code, OTHER_CODES] }, { $ne: [code, nextCode] }] }, null, { $ifNull: ["$review.reason", null] }] },
    "review.by": { $literal: by },
    "review.at": { $literal: at },
  } }], { returnDocument: "after" });
  if (!record?.review) {
    if (change.reason_code && await sourceMap(db).countDocuments({ _id })) throw new Error("Invalid reason code: it doesn't belong to this source's decision");
    throw new Error(`Unknown source: ${sourceId}`);
  }
  const review = record.review;
  // The same decision shows on this page's row in test-mode source runs.
  await keepPageDecision(db, locationId, record, review, null);
  let status = record.status;
  if (change.decision !== undefined) {
    const pinned = record.status === "pinned" || review.initial_status === "pinned";
    status = change.decision === "reject" ? "rejected" : change.decision === "accept" ? pinned ? "pinned" : "active" : review.initial_status;
    await setSourceStatus(db, locationId, sourceId, status);
  }
  await db.collection<SourceReviewEntry>(SOURCE_REVIEWS).insertOne({
    location_id: locationId, source_id: sourceId, url: record.url, name: record.name, section: record.section,
    source_tier: record.source_tier ?? null, scope: record.scope ?? null, source_kind: record.source_kind ?? null,
    found_by: record.found_by, status, link_only: record.link_only ?? false, non_scrapable_reason: nonScrapableReason(record), ...review, reason_label: reasonLabel(review.reason_code),
  });
  return { status, review };
}

export type ReviewChange = { decision?: SourceDecision | null; reason_code?: ReasonCode | null; reason?: string | null };

/**
 * Check a label sent by a person: a decision (accept, reject or null), a reason code from that
 * decision's list, and text only with an Other code. Throws an `Invalid ...` error otherwise.
 */
export function reviewChange(body: { decision?: unknown; reason_code?: unknown; reason?: unknown }): ReviewChange {
  if (body.decision !== undefined && body.decision !== null && body.decision !== "accept" && body.decision !== "reject") throw new Error("Invalid decision: send accept, reject or null");
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") throw new Error("Invalid reason: send text or null");
  const reason = typeof body.reason === "string" ? body.reason.trim() || null : body.reason as null | undefined;
  if (reason && reason.length > MAX_REVIEW_REASON) throw new Error(`Invalid reason: keep it to ${MAX_REVIEW_REASON} characters`);
  const code = body.reason_code;
  if (code !== undefined && code !== null && (typeof code !== "string" || !decisionOf(code))) throw new Error("Invalid reason code: send one from the list or null");
  if (typeof code === "string" && body.decision !== undefined && body.decision !== decisionOf(code)) throw new Error("Invalid reason code: it doesn't belong to this decision");
  if (reason && !(typeof code === "string" && OTHER_CODES.includes(code))) throw new Error("Invalid reason: text goes only with an Other reason code");
  return { decision: body.decision as SourceDecision | null | undefined, reason_code: code as ReasonCode | null | undefined, reason };
}

/** Most sources one bulk decision may label. */
export const MAX_BULK_REVIEW = 500;

/**
 * One decision and reason for many sources (the Source runs tab's bulk accept or reject). Each is
 * saved as its own label, exactly as if it were chosen in its row, so each gets its history row.
 * A source that can't be saved is reported and the rest still are.
 */
export async function saveSourceReviews(db: Db, locationId: string, sourceIds: string[], change: ReviewChange, by: string) {
  const saved: Array<{ source_id: string; status: SourceStatus; review: SourceReview }> = [];
  const failed: Array<{ source_id: string; detail: string }> = [];
  for (const sourceId of [...new Set(sourceIds)]) {
    try { saved.push({ source_id: sourceId, ...await saveSourceReview(db, locationId, sourceId, change, by) }); }
    catch (error) { failed.push({ source_id: sourceId, detail: error instanceof Error ? error.message : String(error) }); }
  }
  return { saved, failed };
}

export async function setSourceWindow(db: Db, locationId: string, sourceId: string, window: LookupWindow | null) {
  const result = await sourceMap(db).updateOne({ _id: `${locationId}:${sourceId}` }, { $set: { window } });
  if (!result.matchedCount) throw new Error(`Unknown source: ${sourceId}`);
}

export async function locationSources(db: Db, locationId: string) {
  return sourceMap(db).find({ location_id: locationId }).sort({ section: 1, status: 1, score: -1, name: 1 }).toArray();
}

/** Deletes source records only: their labels stay in `source_reviews`. */
export async function removeLocationSources(db: Db, locationId: string) {
  await sourceMap(db).deleteMany({ location_id: locationId });
}
