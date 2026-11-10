/**
 * Assembly: from everything collected in a run to the pool the rankers see, in order:
 *
 *   0. title      a title that is only the site's name or a navigation heading, or a publisher's
 *                 headline under four words, is left out with the reason (`title-rules.ts`);
 *   1. locality   items not yet placed are checked: names the place or an alias, names a
 *                 landmark inside it, a street address inside it (geocoded), or the article
 *                 text does; items that fail are dropped with the reason;
 *   2. merging    copies of one story become one merge group (same headline; same event
 *                 and date; same incident block and day; same business; a news report
 *                 about an incident on its street), crediting every source. Before the copies
 *                 are folded into one story, each item records its `replication`: how many
 *                 copies passed the checks, from how many sources and independent publishers;
 *   3. ledger     stories printed in earlier editions are dropped unless they bring new
 *                 facts (an update) or are due a "this week" reminder;
 *   4. sections   each story is placed in a newsletter section;
 *   5. pre-rank   each section is ordered by rules (locality strength, freshness, detail,
 *                 source track record) and its top RATED_PER_SECTION go to the model.
 *
 * Every item's outcome is written back to `collected_items`, which the run inspector's item
 * trace and the edition map read.
 */
import type { Db } from "mongodb";
import type { CollectedEvent, ConnectorContext, LocationProfile } from "../connectors/types";
import { addressEvidence, articleText, localityFor, outsideEventVenue, quickEvidence, type Locality, type LocalityEvidence } from "../connectors/locality";
import { townName } from "../connectors/locality";
import { ruleTier } from "../search/classifier";
import { mentions } from "../connectors/community";
import type { Fetcher } from "../connectors/fetcher";
import { hostOf, reviewedLocationSources } from "../sourcemap/store";
import { reviewAllowsCollection } from "../sourcemap/source-review";
import { normaliseName, titleProblem, urlDate } from "./title-rules";
import type { Logger } from "../core/log";
import type { Settings } from "../core/config";
import type { HttpTransport } from "../core/http";
import { MongoLinkCache } from "../storage/link-cache";
import { editionPeriodStart, ingestWindow } from "../core/time";
import { collapse, storyId, type SourceEvent, type Story } from "./stories";
import { ledgerDecision, ledgerHistory, storyTokens } from "./ledger";
import { factCount, mergeDetails, textFor, type Details } from "./details";
import { NEWS_KINDS } from "../editorial/kinds";
import { currentOptions, limits, rulesOff } from "../core/run-options";
import { SECTIONS, sectionFor, WIDER_SECTIONS, type SectionId } from "../sourcemap/sections";
import { sourceMap } from "../sourcemap/store";
import type { EvidencePacket } from "./evidence";

export const COLLECTED_ITEMS = "collected_items";
export const LOCALITY_BUDGET = { geocodes: 40, articles: 20 };
/** Only the start of an article counts as evidence (sidebars and menus come later or not at all). */
export const BODY_CHARS = 3000;

/** The names an item can use for the place: the community and its coverage terms, or the town. */
export function placeNames(location: LocationProfile) {
  return location.community ? [...new Set([location.community.name, ...location.community.coverage_terms])] : [townName(location)];
}
export function countMentions(text: string, name: string) {
  if (!text || !name) return 0;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "gi")) ?? []).length;
}

export type ItemStatus = "collected" | "dropped" | "pooled" | "candidate" | "published" | "held" | "not_selected";
/**
 * How often one story turned up among the items that passed the checks, counted before its copies
 * were merged: every copy, the sources they came from, and the independent publishers among them
 * (distinct sites, not counting reposts).
 */
export type Replication = { copies: number; sources: number; independent: number; publishers: string[] };
export type CollectedItem = {
  _id: string;
  run_id: string;
  location_id: string;
  source_id: string;
  source_name: string;
  title: string;
  url: string | null;
  event_date: string | null;
  status: ItemStatus;
  /** Why it was dropped or not selected (shown on the edition map and item trace). */
  reason: string | null;
  /** The step that decided it: reader, locality, merge, ledger, ranking, authoring. */
  step: string;
  facts: CollectedEvent | null;
  section?: SectionId | null;
  merge_group?: string | null;
  story_id?: string | null;
  replication?: Replication;
  /** The local pre-ranker's rating, saved next to the model's in every rated section (`ranking/pre-ranker.ts`). */
  pre_rank?: { score: number; civic: number; appeal: number; special: number; rules: string[]; policy: string };
  locality?: unknown;
  rank?: number | null;
  score?: number | null;
  why?: string | null;
  evidence?: EvidencePacket;
  /** Rules exploration let this item through, which strict would have applied. */
  would_have_blocked?: string[];
  access_overrides?: string[];
  created_at: number;
};

export function collectedItems(db: Db) { return db.collection<CollectedItem>(COLLECTED_ITEMS); }
export async function ensureItemIndexes(db: Db) {
  await collectedItems(db).createIndexes([{ key: { run_id: 1, status: 1 } }, { key: { run_id: 1, source_id: 1 } }, { key: { created_at: 1 }, expireAfterSeconds: 90 * 86400 }]);
}

export type AssembleContext = { db: Db; settings: Settings; transport: HttpTransport; fetcher: Fetcher; location: LocationProfile; today: string; log: Logger; runId: string; overrides?: RunOverrides };
export type RunOverrides = { include?: string[]; exclude?: string[]; pin?: string[] };

const NOISE = /[^a-z0-9]+/g;
export function headlineKey(title: string) {
  return title.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+[-|–—]\s+[^-|–—]{2,60}$/, "").replace(NOISE, " ").trim();
}
function streetOf(block: string) {
  return /block of (.+)$/i.exec(block)?.[1]?.trim() ?? null;
}

/** Union-find over items: indices that share any key end up in one group. */
function groupItems(items: CollectedEvent[]) {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (a: number, b: number) => { const left = find(a), right = find(b); if (left !== right) parent[Math.max(left, right)] = Math.min(left, right); };
  const byKey = new Map<string, number>();
  const link = (key: string | null, index: number) => {
    if (!key) return;
    const seen = byKey.get(key);
    if (seen === undefined) byKey.set(key, index); else union(seen, index);
  };
  items.forEach((item, index) => {
    const kind = String(item.kind ?? "event");
    const headline = headlineKey(item.title);
    // Calendar and public-record URLs may identify a whole list, not one occurrence.
    if (["local_news", "news_report", "social_trend"].includes(kind) && item.source_url) {
      try { const url = new URL(item.source_url); url.hash = ""; for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/.test(key)) url.searchParams.delete(key);
        link(`url:${url.toString()}:${item.event_date}`, index); } catch { /* invalid URL cannot identify a story */ }
    }
    if (headline.length >= 12) link(kind === "event" || kind === "meeting_preview" ? `h:${headline}:${item.event_date}` : `h:${headline}`, index);
    const incident = item.incident as { block?: string } | undefined;
    if (kind === "safety_incident" && incident?.block) link(`incident:${incident.block.toLowerCase()}:${item.event_date}`, index);
    if (kind === "business_opening" || kind === "public_record") {
      const name = headlineKey(String(item.title).split(/ applies for| inspected/)[0]);
      if (name.length >= 4 && !item.summary) link(`business:${name}`, index);
    }
  });
  // A news report naming an incident's street on the same or next day joins the incident.
  const incidents = items.map((item, index) => ({ item, index })).filter(({ item }) => item.kind === "safety_incident" && !item.summary && (item.incident as { block?: string } | undefined)?.block);
  items.forEach((item, index) => {
    if (item.kind === "safety_incident" || !["news_report", "local_news", "court_case", "state_news"].includes(String(item.kind))) return;
    const text = `${item.title} ${item.description ?? ""}`;
    for (const { item: incident, index: target } of incidents) {
      const street = streetOf(String((incident.incident as { block: string }).block));
      const days = Math.abs(Date.parse(`${item.event_date}T00:00:00Z`) - Date.parse(`${incident.event_date}T00:00:00Z`)) / 86400_000;
      if (street && street.length > 5 && days <= 1 && mentions(text, street)) { union(index, target); break; }
    }
  });
  return items.map((_, index) => find(index));
}

const TIER_WEIGHT: Record<string, number> = { local: 3, nearby: 1, region: 1 };
/** Source types, primary first. Original local reporting keeps its place; only rewrites are demoted. */
const SOURCE_TIER_WEIGHT: Record<string, number> = { official: 4, organisation: 3, business: 3, local_reporting: 2, repost: 0 };
/** These reprint what's available even when they don't name the place, under exploration. */
const PRINT_ANYWAY = new Set(["obituary", "home_sale", "building_permit", "school_sports", "game_result"]);
const NEWSROOM_METHODS = new Set(["newsrooms", "publishers"]);
/**
 * Points for independent confirmation: 1.5 × log2(independent publishers), at most 3. One publisher
 * adds nothing, two add 1.5, three about 2.4, four or more 3. Copies from one publisher add nothing.
 */
export function independentBonus(independent: number | null | undefined) {
  return Math.min(3, 1.5 * Math.log2(Math.max(1, Number(independent ?? 1))));
}
/** Rule score for ordering inside a section before the model rates it. */
export function ruleScore(story: Story, today: string, sourceScore: number, pinned: boolean) {
  const facts = story.facts;
  const details = facts.details as Details | undefined;
  const news = NEWS_KINDS.has(story.kind);
  const days = Math.abs(Date.parse(`${story.first.event_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000;
  const freshness = news ? Math.max(0, 7 - days) / 7 : Math.max(0, 14 - days) / 14;
  const detail = details ? Math.min(6, factCount(details)) / 6 : 0;
  const independent = (facts.replication as Replication | undefined)?.independent ?? 1;
  return (pinned ? 100 : 0) + (TIER_WEIGHT[String(facts.tier ?? "local")] ?? 1) + (SOURCE_TIER_WEIGHT[String(facts.source_tier)] ?? 1) + 2 * freshness + 2 * detail + Math.min(2, sourceScore / 5) + independentBonus(independent) + (facts.update_of ? 0.5 : 0);
}

/** The publisher a copy counts under: its source's site, else the copy's own site, else the source's name. */
function publisherOf(sourceUrl: string | null | undefined, itemUrl: string | null | undefined, sourceName: string) {
  return hostOf(sourceUrl) || hostOf(itemUrl) || normaliseName(sourceName);
}

export type PoolSection = { id: SectionId; label: string; stories: string[]; considered: number };
export type Pool = { events: SourceEvent[]; sections: PoolSection[]; funnel: Record<string, number>; tokens: Record<string, string[]> };

export async function assemble(context: AssembleContext): Promise<Pool> {
  const { db, runId, location, today } = context;
  const overrides = context.overrides ?? {};
  const items = await collectedItems(db).find({ run_id: runId, status: { $in: ["collected", "pooled", "candidate", "not_selected"] } }).toArray();
  const collectedCount = await collectedItems(db).countDocuments({ run_id: runId });
  const decide = async (id: string, values: Partial<CollectedItem>) => { await collectedItems(db).updateOne({ _id: id }, { $set: values }); };

  // 1. Locality for items not yet placed by their reader.
  const connectorContext = { ...context, window: ingestWindow(today), linkCache: new MongoLinkCache(db), transport: context.transport } as unknown as ConnectorContext;
  const locality: Locality = await localityFor(connectorContext, { ...LOCALITY_BUDGET });
  const records = await sourceMap(db).find({ location_id: location.id }, { projection: { source_id: 1, section: 1, score: 1, status: 1, source_tier: 1, url: 1, name: 1, "found_by.method": 1, params: 1 } }).toArray();
  const bySource = new Map(records.map((record) => [record.source_id, record]));
  const kept: CollectedItem[] = [];
  const localNames = [location.community?.name, location.community?.parent_name, townName(location)].filter((name): name is string => Boolean(name));
  let titleDropped = 0;
  const sourceReviews = await reviewedLocationSources(db, location.id);
  const reviewHolds = new Map(sourceReviews.filter((source) => !reviewAllowsCollection(source.access_review, new Date().toISOString().slice(0, 10)))
    .map((source) => [source.source_id, source.access_review!.reason]));
  for (const item of items) {
    const facts = item.facts!;
    if (reviewHolds.has(item.source_id)) {
      await decide(item._id, { status: "dropped", reason: `Source access review: ${reviewHolds.get(item.source_id)}`, step: "reader" });
      continue;
    }
    // A source may have been rejected or paused after its reader queued these items.
    const source = bySource.get(item.source_id);
    const unapproved = source?.status === "proposed" && (context.settings.proposedUntilApproved || currentOptions().flow !== "agentic");
    if (source?.status === "rejected" || source?.status === "paused" || unapproved) {
      await decide(item._id, { status: "dropped", reason: `source is ${source.status}; not eligible for this edition`, step: "source_review" }); continue;
    }
    if (overrides.exclude?.includes(item._id)) { await decide(item._id, { status: "dropped", reason: "excluded by an editor", step: "editor" }); continue; }
    if (overrides.include?.includes(item._id)) { facts.tier = facts.tier ?? "local"; facts.locality = facts.locality ?? { method: "editor", matches: [] }; kept.push(item); continue; }
    // A source saved as one dated story is named after it, so only a real site name is compared.
    const titleIssue = titleProblem(String(facts.title ?? item.title), String(facts.kind ?? ""), [facts.site_name as string | undefined, urlDate(source?.url) ? null : item.source_name]);
    if (titleIssue) {
      titleDropped += 1;
      // Exploration keeps it, flagged, like the other quality rules.
      if (rulesOff("quality")) await decide(item._id, { would_have_blocked: ["title"], reason: titleIssue });
      else { await decide(item._id, { status: "dropped", reason: titleIssue, step: "title" }); continue; }
    }
    if (!facts.needs_locality) { kept.push(item); continue; }
    // A no-school notice in an authority-selected local school's calendar applies to
    // its pupils even without a physical venue. This does not localize district events.
    const school = bySource.get(item.source_id);
    if (facts.kind === "event" && /\bno school\b|\bschool (?:is )?closed\b/i.test(facts.title) &&
        school?.section === "schools" && school.found_by?.method === "directories" &&
        school.params?.directory_selection === `School name matches ${location.community?.name}` &&
        typeof school.params?.authority_directory_url === "string") {
      facts.tier = "local"; facts.needs_locality = false;
      facts.locality = { method: "school_calendar_scope", matches: [school.url, school.params.authority_directory_url] };
      await decide(item._id, { locality: facts.locality }); kept.push(item); continue;
    }
    const outsideVenue = facts.kind === "event" ? await outsideEventVenue(locality, facts.description as string | null).catch(() => null) : null;
    if (outsideVenue) {
      await decide(item._id, { status: "dropped", reason: `event venue outside neighborhood: ${outsideVenue}`, step: "locality" }); continue;
    }
    // Headline, summary and venue first; the article body counts only near its start and only
    // with two mentions (a sidebar or menu naming the place once is not evidence).
    const head = [facts.title, facts.description as string | null, facts.venue, facts.source_url];
    const coordinates = Array.isArray(facts.coordinates) ? facts.coordinates as [number, number] : undefined;
    let evidence: LocalityEvidence | null = quickEvidence(locality, head, coordinates) ?? await addressEvidence(locality, head.slice(0, 2)).catch(() => null);
    if (!evidence) {
      const body = (await textFor(db, facts.source_url)) ?? (facts.link_only || facts.no_page_fetch ? null : await articleText(locality, facts.source_url));
      const opening = body?.slice(0, BODY_CHARS) ?? "";
      const names = placeNames(location);
      const count = names.reduce((sum, name) => sum + countMentions(opening, name), 0);
      if (count >= 2) evidence = { method: "article", matches: names.filter((name) => countMentions(opening, name) > 0) };
      else if (count === 1) {
        const landmark = locality.landmarks.find((name) => mentions(opening, name));
        if (landmark) evidence = { method: "article", matches: [landmark], via: "landmark" };
      }
    }
    if (evidence) {
      facts.tier = "local"; facts.locality = evidence; facts.needs_locality = false;
      await decide(item._id, { locality: evidence });
      kept.push(item);
      continue;
    }
    // City- or county-wide: the headline or summary is about the parent city.
    const parent = location.community ? townName(location) : null;
    if (parent && head.slice(0, 2).some((value) => mentions(value, parent))) {
      facts.tier = "region"; facts.locality = { method: "parent_city", matches: [parent] }; facts.needs_locality = false;
      await decide(item._id, { locality: facts.locality });
      kept.push(item);
      continue;
    }
    const reason = `not local: doesn't name ${location.community?.name ?? townName(location)}, a landmark in it, or an address inside it`;
    // Exploration keeps it, flagged and ranked lower, instead of dropping it, as long as it names
    // the place or its city or is a notice that prints anyway. Other news is never local.
    const namesCity = PRINT_ANYWAY.has(String(facts.kind)) || localNames.some((name) => head.slice(0, 2).some((value) => mentions(value, name)));
    if (rulesOff("quality") && namesCity) {
      facts.tier = "nearby"; facts.locality = { method: "flagged", matches: [] }; facts.needs_locality = false;
      await decide(item._id, { locality: facts.locality, would_have_blocked: ["locality"], reason });
      kept.push(item);
      continue;
    }
    await decide(item._id, { status: "dropped", reason, step: "locality" });
  }

  // 2. Merge copies of one story.
  const events = kept.map((item) => item.facts!);
  const groups = groupItems(events);
  const groupKey = new Map<number, string>();
  const groupMembers = new Map<number, number[]>();
  groups.forEach((root, index) => groupMembers.set(root, [...(groupMembers.get(root) ?? []), index]));
  for (const [root, members] of groupMembers) {
    // The primary source leads, then the most local copy, then the fullest, then the earliest.
    members.sort((a, b) => (SOURCE_TIER_WEIGHT[String(events[b].source_tier)] ?? 1) - (SOURCE_TIER_WEIGHT[String(events[a].source_tier)] ?? 1)
      || (TIER_WEIGHT[String(events[b].tier ?? "local")] ?? 1) - (TIER_WEIGHT[String(events[a].tier ?? "local")] ?? 1)
      || factCount(mergeDetails(events[b].details as Details)) - factCount(mergeDetails(events[a].details as Details))
      || String(events[b].description ?? "").length - String(events[a].description ?? "").length);
    const lead = events[members[0]];
    const key = `${lead.kind ?? "event"}:${headlineKey(lead.title)}${["event", "meeting_preview"].includes(String(lead.kind)) ? `:${lead.event_date}` : ""}`;
    groupKey.set(root, key);
    lead.details = mergeDetails(...members.map((index) => events[index].details as Details));
    lead.also_from = [...new Set(members.slice(1).map((index) => String(events[index].source_name ?? kept[index].source_name)))].filter((name) => name !== lead.source_name);
    lead.lead = true;
    groupMembers.set(root, members);
  }
  // Replication, counted before the copies are folded into one story. Reposts don't count as
  // independent publishers, and many sources on one site count as one.
  const replicationOf = new Map<number, Replication>();
  for (const [root, members] of groupMembers) {
    const publishers = new Set<string>();
    for (const index of members) {
      if (String(events[index].source_tier ?? bySource.get(kept[index].source_id)?.source_tier ?? "") === "repost") continue;
      publishers.add(publisherOf(bySource.get(kept[index].source_id)?.url, events[index].source_url as string | undefined, kept[index].source_name));
    }
    replicationOf.set(root, { copies: members.length, sources: new Set(members.map((index) => kept[index].source_id)).size, independent: Math.max(1, publishers.size), publishers: [...publishers].slice(0, 12) });
  }
  let mergedCopies = 0;
  const sourceEvents: SourceEvent[] = [];
  for (const [root, members] of groupMembers) {
    const replication = replicationOf.get(root)!;
    for (const [position, index] of members.entries()) {
      const facts = events[index];
      facts.merge_group = groupKey.get(root)!;
      facts.replication = replication;
      sourceEvents.push({ source_id: kept[index].source_id, facts });
      const lead = kept[members[0]];
      if (position) mergedCopies += 1;
      await decide(kept[index]._id, { merge_group: String(facts.merge_group), story_id: storyId(String(facts.merge_group)), replication, ...(position ? { reason: `merged into "${lead.title}" from ${lead.source_name}`, step: "merge" } : {}) });
    }
  }
  // Leads first, so each story's facts are its best copy.
  sourceEvents.sort((a, b) => Number(Boolean(b.facts.lead)) - Number(Boolean(a.facts.lead)));
  let stories = collapse(sourceEvents);

  // 3. Ledger: no repeats across editions.
  const history = await ledgerHistory(db, location.id, stories.map((story) => story.id));
  const periodStart = editionPeriodStart(today);
  const tokens: Record<string, string[]> = {};
  const survivors: Story[] = [];
  let repeats = 0;
  for (const story of stories) {
    const details = story.facts.details as Details | undefined;
    const storyText = `${story.title} ${story.description ?? ""} ${(details?.people ?? []).join(" ")} ${(details?.numbers ?? []).join(" ")}`;
    tokens[story.id] = storyTokens(storyText);
    const forced = overrides.include?.some((id) => story.occurrences.some((occurrence) => id.endsWith(`:${occurrence.source_event_id}`)));
    const decision = forced ? { keep: true as const } : ledgerDecision(history.get(story.id) ?? [], { event_date: story.first.event_date, news: NEWS_KINDS.has(story.kind), tokens: tokens[story.id] }, today, periodStart);
    if (!decision.keep) {
      const reason = `${decision.reason} (printed in the edition of ${decision.printed_on})`;
      if (rulesOff("quality")) {
        await collectedItems(db).updateMany({ run_id: runId, story_id: story.id }, { $set: { reason, would_have_blocked: ["no_repeat"] } });
        survivors.push(story);
        continue;
      }
      await collectedItems(db).updateMany({ run_id: runId, story_id: story.id }, { $set: { status: "dropped", reason, step: "ledger" } });
      repeats += 1;
      continue;
    }
    if (decision.update_of) story.facts.update_of = decision.update_of;
    if (decision.reminder) story.facts.reminder = true;
    survivors.push(story);
  }
  stories = survivors;

  // 4 and 5. Sections and rule order.
  // Primary sources rank first, so every source needs a tier, including those found before tiers existed.
  for (const story of stories) {
    const record = bySource.get(story.first.source_id);
    if (!story.facts.source_tier && record?.url) story.facts.source_tier = record.source_tier ?? (NEWSROOM_METHODS.has(record.found_by?.method) ? "local_reporting" : ruleTier(record.url, record.name));
  }
  const sections = new Map<SectionId, Story[]>();
  let widerKept = 0;
  for (const story of stories) {
    const record = bySource.get(story.first.source_id);
    const section = sectionFor({ kind: story.kind, title: story.title, description: story.description, section_id: story.facts.section_id }, (story.facts.section_hint as string | null) ?? record?.section ?? null);
    story.facts.section_id = section;
    const wider = ["region", "nearby"].includes(String(story.facts.tier ?? "local"));
    const servingVenue = story.kind === "event" && story.facts.serves_community === true &&
      (story.facts.locality as { method?: string; distance_km?: number } | undefined)?.method === "verified_venue" &&
      Number((story.facts.locality as { distance_km?: number }).distance_km) <= 3;
    if (wider && !WIDER_SECTIONS.has(section) && !servingVenue) {
      const reason = `city-wide item outside ${[...WIDER_SECTIONS].join(", ")}`;
      if (rulesOff("caps") || rulesOff("quality")) await collectedItems(db).updateMany({ run_id: runId, story_id: story.id }, { $set: { reason, would_have_blocked: ["city_wide_limit"] } });
      else {
        await collectedItems(db).updateMany({ run_id: runId, story_id: story.id }, { $set: { status: "dropped", reason, step: "locality", section } });
        continue;
      }
    }
    if (wider) widerKept += 1;
    sections.set(section, [...(sections.get(section) ?? []), story]);
  }
  const pool: PoolSection[] = [];
  const pooledIds = new Set<string>();
  for (const definition of SECTIONS) {
    const list = sections.get(definition.id) ?? [];
    if (!list.length) continue;
    const scored = list.map((story) => {
      const record = bySource.get(story.first.source_id);
      const pinned = record?.status === "pinned" || Boolean(overrides.pin?.some((id) => story.occurrences.some((occurrence) => id.endsWith(`:${occurrence.source_event_id}`))));
      return { story, score: ruleScore(story, today, record?.score ?? 0, pinned) };
    }).sort((a, b) => b.score - a.score);
    const RATED_PER_SECTION = limits().ratedPerSection;
    const chosen = scored.slice(0, RATED_PER_SECTION);
    for (const { story, score } of chosen) {
      pooledIds.add(story.id);
      await collectedItems(db).updateMany({ run_id: runId, story_id: story.id }, { $set: { status: "pooled", section: definition.id, score: Math.round(score * 100) / 100, step: "ranking" } });
    }
    for (const { story } of scored.slice(RATED_PER_SECTION)) {
      await collectedItems(db).updateMany({ run_id: runId, story_id: story.id }, { $set: { status: "not_selected", reason: `below the section's top ${RATED_PER_SECTION} by rule score`, section: definition.id, step: "ranking" } });
    }
    pool.push({ id: definition.id, label: definition.label, stories: chosen.map(({ story }) => story.id), considered: list.length });
  }
  const poolEvents = sourceEvents.filter((event) => pooledIds.has(storyId(String(event.facts.merge_group))));
  return {
    events: poolEvents, sections: pool, tokens: Object.fromEntries(Object.entries(tokens).filter(([id]) => pooledIds.has(id))),
    funnel: { items_collected: collectedCount, title_dropped: titleDropped, local: kept.length, merged_copies: mergedCopies, after_merge: groupMembers.size, repeats, not_printed: stories.length, pooled: pooledIds.size, wider: widerKept },
  };
}
