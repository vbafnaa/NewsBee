/**
 * The source map: one record per source per location, in MongoDB `source_map`. Discovery
 * writes candidates here, editors pin, pause, reject or add sources here, and collection
 * reads only from here. A record's `_id` is `<location id>:<source id>`; the source id is
 * also the collection task's id, so run results, health and the edition map line up.
 */
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { LookupWindow, SourceTask, SourceType } from "../connectors/types";
import { nonScrapableReason } from "./display";
import { decisionOf, OTHER_CODES, reasonLabel, type ReasonCode } from "./reasons";
import { itemCap, limits } from "../core/run-options";
import { recordDecision } from "../trace/decisions";
import { CATEGORIES, SECTION_LABELS, type SectionId } from "./sections";

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
  | "government" | "osm" | "meetings" | "opendata" | "newsrooms" | "athletics" | "schools" | "groups" | "publishers" | "llm"
  | "directories" | "dork" | "agent" | "national" | "library" | "editor" | "reader_suggestion" | "migrated";

export const METHOD_LABELS: Record<DiscoveryMethod, string> = {
  government: "City or county website",
  directories: "Official institution directory",
  osm: "OpenStreetMap place inside the area",
  meetings: "Meeting platform account",
  opendata: "Open-data portal",
  newsrooms: "Wikidata newsroom nearby",
  athletics: "State athletic association (Wikidata)",
  schools: "School district directory and school websites",
  groups: "Local group or funeral home website, then checked",
  publishers: "Publisher found by news search",
  llm: "Suggested by Gemini, then checked",
  dork: "Google operator search, then checked",
  agent: "Found by the mapping agent, then checked",
  national: "National public data",
  library: "Library directory",
  editor: "Added by an editor",
  reader_suggestion: "Suggested by a reader",
  migrated: "Earlier source link",
};

/** `proposed` sources were found by the agentic flow: only agentic runs read them, until promoted. */
export type SourceStatus = "active" | "pinned" | "paused" | "rejected" | "dormant" | "proposed";
export type SourceTier = "official" | "organisation" | "business" | "local_reporting" | "repost";
/** The widest area a source covers. Items from a wider source still have to pass the locality filter. */
export type SourceScope = "place" | "city" | "county";
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
  found_by: { method: DiscoveryMethod; detail: string; query?: string | null };
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
};

export type SourceCandidate = Omit<SourceRecord, "_id" | "location_id" | "status" | "health" | "score" | "first_seen" | "last_seen" | "note" | "dormant_until" | "review"> & { status?: SourceStatus; note?: string | null; /** A checked section of a site, not a second copy of its home page. Not saved. */ section_page?: boolean };

export function sourceMap(db: Db) {
  return db.collection<SourceRecord>(SOURCE_MAP);
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
 * Write discovery candidates for a location. New sources are added as active; existing
 * ones keep their editor status, note, review and health, and get fresh details. A rejected
 * source stays rejected. Returns how many were new.
 */
export async function upsertCandidates(db: Db, locationId: string, candidates: SourceCandidate[]) {
  const now = new Date().toISOString();
  let added = 0;
  const seenHosts = new Map<string, number>();
  for (const candidate of candidates) {
    const _id = `${locationId}:${candidate.source_id}`;
    const existing = await sourceMap(db).findOne({ _id }, { projection: { status: 1, found_by: 1 } });
    // A checked page's id follows its feed, which can come and go. A page a person rejected stays out under either id.
    if (!existing && candidate.section_page && candidate.source_kind && await sourceMap(db).findOne({ location_id: locationId, url: candidate.url, status: "rejected" }, { projection: { _id: 1 } })) {
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
      const cap = candidate.section_page ? itemCap(SECTION_PAGES_PER_HOST) : candidate.status === "proposed" || specificPage ? itemCap(PROPOSED_PER_HOST) : limits().newWebPerHost;
      if (candidate.status !== "pinned" && count >= cap) { await recordDecision({ stage: "source", actor: "rule", subject: candidate.url, decision: "not_added", reason: `${count} sources from ${host} are already on the map`, rule: "per_host_limit", topic: candidate.topics?.[0] ?? null }); continue; }
    }
    // An agentic find never changes a source already on the map: current runs must stay a clean baseline.
    if (existing && existing.status !== "proposed" && candidate.status === "proposed") {
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
      ...(candidate.latest_day ? { latest_day: candidate.latest_day } : {}),
    };
    await sourceMap(db).updateOne({ _id }, {
      $set: set,
      $setOnInsert: { status: candidate.status ?? "active", note: candidate.note ?? null, health: emptyHealth(), score: 0, first_seen: now, dormant_until: null },
    }, { upsert: true });
    if (!existing) added += 1;
    await recordDecision({ stage: "source", actor: candidate.found_by.method === "agent" ? "agent" : "rule", subject: candidate.url ?? candidate.source_id, decision: existing ? "refreshed" : candidate.status === "proposed" ? "proposed" : "added", reason: candidate.why ?? candidate.found_by.detail, topic: candidate.topics?.[0] ?? null, evidence: { method: candidate.found_by.method, query: candidate.found_by.query ?? null, tier: candidate.source_tier ?? null, name: candidate.name } });
  }
  return added;
}

/**
 * Sources collected this run: active and pinned, plus dormant ones due a retry. Agentic runs
 * also read proposed sources, so current runs stay a clean baseline. Link-only sources are never collected.
 */
export async function collectableSources(db: Db, locationId: string, today: string, flow: "current" | "agentic" = "current") {
  const records = await sourceMap(db).find({ location_id: locationId, status: { $in: flow === "agentic" ? ["active", "pinned", "dormant", "proposed"] : ["active", "pinned", "dormant"] }, link_only: { $ne: true } }).toArray();
  return records.filter((record) => record.status !== "dormant" || !record.dormant_until || record.dormant_until <= today)
    .sort((a, b) => Number(b.status === "pinned") - Number(a.status === "pinned") || b.score - a.score || a.name.localeCompare(b.name));
}

export function taskFor(record: SourceRecord): SourceTask {
  return { type: record.reader, source_id: record.source_id, name: record.name, params: { ...record.params, source_map_id: record._id, ...(record.window ? { window: record.window } : {}), ...(record.source_tier ? { source_tier: record.source_tier } : {}) } };
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
