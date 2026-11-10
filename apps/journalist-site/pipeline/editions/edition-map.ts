/**
 * The edition map: how one edition was made, from every source on the map to the stories
 * printed. Written when items are assembled, when candidates are chosen and when the
 * edition is published (`edition_maps`, one document per run), so internal source review
 * loads the decisions in one read.
 *
 * Public-safety rule: items held by the writing floor (minors, victims) are counted, never
 * listed by headline.
 */
import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import { METHOD_LABELS, sourceMap, STALE_DAYS, type SourceRecord } from "../sourcemap/store";
import { SECTIONS, sectionLabel, type SectionId, CANDIDATES_PER_SECTION, PUBLISHED_PER_SECTION } from "../sourcemap/sections";
import { describeWindow, WINDOWS } from "../sourcemap/windows";
import { CONNECTORS, windowOf } from "../connectors/registry";
import { collectedItems, type CollectedItem } from "./assemble";
import { addDays } from "../connectors/common";

export const EDITION_MAPS = "edition_maps";
export const MAX_ITEMS_PER_SOURCE = 60;

export type MapItem = { id: string; title: string; url: string | null; event_date: string | null; status: string; reason: string | null; step: string; section: string | null; rank: number | null; score: number | null; why: string | null; story_id: string | null };
export type MapSource = {
  source_id: string; name: string; url: string | null; type: string; type_label: string; found_by: string; found_by_detail: string; status: string; stale: boolean;
  last_new_item_day: string | null; window: string; run_status: string | null; run_detail: string | null; collected: boolean;
  items_pulled: number; items_kept: number; items_published: number; items: MapItem[]; link_only: boolean;
};
export type EditionMap = {
  _id: string; run_id: string; location_id: string; location_name: string; status: "assembling" | "ranked" | "built" | "published"; edition_id: string | null;
  today: string; window: [string, string]; published_at: number | null; generated_at: number;
  funnel: Array<{ step: string; label: string; count: number }>;
  sections: Array<{ id: string; label: string; sources: MapSource[]; published: number; candidates: number }>;
  held_by_floor: number;
  totals: { sources: number; collected: number; published: number };
};

export function editionMaps(db: Db) { return db.collection<EditionMap>(EDITION_MAPS); }

const TYPE_LABELS: Record<string, string> = { web: "Website or feed", opendata: "Open data", newssearch: "News search", library: "Library calendar", meetings: "Meeting records", hazards: "Weather and earthquake alerts", trending: "Trending topics", homesafety: "Drinking water records", housing: "Building permit statistics", remembrance: "Family notices", justice: "Prosecutor releases", community: "Reader stories" };

function mapItem(item: CollectedItem): MapItem {
  return { id: item._id, title: item.title, url: item.url, event_date: item.event_date, status: item.status, reason: item.reason, step: item.step, section: item.section ?? null, rank: item.rank ?? null, score: item.score ?? null, why: item.why ?? null, story_id: item.story_id ?? null };
}

export async function buildEditionMap(db: Db, runId: string) {
  const run = await db.collection(COLLECTIONS.runs).findOne({ _id: runId as never }) as unknown as { _id: string; location_id: string; location_name: string; today: string; window: [string, string]; sources: Array<{ source_id: string; name: string; type: string; status: string; result_status: string | null; detail: string | null; event_count: number }>; edition_id: string | null } | null;
  if (!run) return null;
  const draft = await db.collection(COLLECTIONS.editions).findOne({ run_id: runId }) as unknown as { status: string; published_at?: number; candidates?: Array<{ section: string }>; published?: { items: Array<{ section_id?: string }> }; funnel?: Record<string, number> } | null;
  const records = await sourceMap(db).find({ location_id: run.location_id, status: { $ne: "rejected" } }).toArray();
  const items = await collectedItems(db).find({ run_id: runId }, { projection: { facts: 0, evidence: 0 } }).toArray();
  const bySource = new Map<string, CollectedItem[]>();
  for (const item of items) bySource.set(item.source_id, [...(bySource.get(item.source_id) ?? []), item]);
  const runSources = new Map(run.sources.map((source) => [source.source_id, source]));
  const staleBefore = addDays(run.today, -STALE_DAYS);
  const held = items.filter((item) => item.status === "held" && /floor:names_withheld/.test(item.reason ?? "")).length;

  const sourceEntry = (record: SourceRecord | null, sourceId: string): MapSource => {
    const ran = runSources.get(sourceId);
    const list = bySource.get(sourceId) ?? [];
    const connector = CONNECTORS[(record?.reader ?? ran?.type ?? "web") as keyof typeof CONNECTORS];
    const window = connector ? describeWindow(windowOf(connector, { type: connector.type, source_id: sourceId, name: "", params: { ...(record?.params ?? {}), ...(record?.window ? { window: record.window } : {}) } })) : describeWindow(WINDOWS.news);
    const lastNew = record?.health?.last_new_item_day ?? null;
    return {
      source_id: sourceId, name: record?.name ?? ran?.name ?? sourceId, url: record?.url ?? null, type: record?.reader ?? ran?.type ?? "web",
      type_label: TYPE_LABELS[record?.reader ?? ran?.type ?? "web"] ?? "Source", found_by: record ? METHOD_LABELS[record.found_by.method] ?? record.found_by.method : "National public data",
      found_by_detail: record?.found_by.detail ?? "", status: record?.status ?? "active",
      stale: record?.status === "paused" || record?.status === "dormant" || Boolean(lastNew && lastNew < staleBefore) || Boolean(record && !lastNew && (record.health?.runs ?? 0) >= 3),
      last_new_item_day: lastNew, window, run_status: ran?.result_status ?? (ran ? ran.status : null), run_detail: ran?.detail ?? null, collected: Boolean(ran),
      items_pulled: list.length, items_kept: list.filter((item) => !["dropped"].includes(item.status)).length, items_published: list.filter((item) => item.status === "published").length,
      // Items the floor held are counted, never listed.
      items: list.filter((item) => !(item.status === "held" && /floor:names_withheld/.test(item.reason ?? ""))).slice(0, MAX_ITEMS_PER_SOURCE).map(mapItem),
      link_only: Boolean(record?.link_only),
    };
  };
  const sectionSources = new Map<SectionId, MapSource[]>();
  const seen = new Set<string>();
  for (const record of records) {
    seen.add(record.source_id);
    sectionSources.set(record.section, [...(sectionSources.get(record.section) ?? []), sourceEntry(record, record.source_id)]);
  }
  for (const source of run.sources) {
    if (seen.has(source.source_id)) continue;
    sectionSources.set("news", [...(sectionSources.get("news") ?? []), sourceEntry(null, source.source_id)]);
  }
  const published = draft?.published?.items ?? [];
  const candidates = draft?.candidates ?? [];
  const sections = SECTIONS.map((section) => ({
    id: section.id, label: sectionLabel(section.id),
    sources: (sectionSources.get(section.id) ?? []).sort((a, b) => b.items_published - a.items_published || b.items_kept - a.items_kept || Number(a.stale) - Number(b.stale) || a.name.localeCompare(b.name)),
    published: published.filter((item) => item.section_id === section.id).length,
    candidates: candidates.filter((item) => item.section === section.id).length,
  })).filter((section) => section.sources.length);
  const active = records.filter((record) => ["active", "pinned", "dormant"].includes(record.status) && !record.link_only).length;
  const returning = new Set(items.map((item) => item.source_id)).size;
  const funnel = draft?.funnel ?? {};
  const finished = draft?.status === "built" || draft?.status === "published";
  const status = finished ? draft!.status as "built" | "published" : candidates.length ? "ranked" : "assembling";
  const map: EditionMap = {
    _id: runId, run_id: runId, location_id: run.location_id, location_name: run.location_name, status, edition_id: finished ? run.edition_id : null,
    today: run.today, window: run.window, published_at: draft?.published_at ?? null, generated_at: Date.now() / 1000,
    funnel: [
      { step: "sources", label: "Sources on the map", count: active },
      { step: "returning", label: "Sources that returned items", count: returning },
      { step: "collected", label: "Items collected", count: items.length },
      { step: "local", label: "Kept as local", count: funnel.local ?? items.filter((item) => item.step !== "reader" && item.step !== "locality").length },
      { step: "merged", label: "Stories after merging repeats", count: funnel.after_merge ?? 0 },
      { step: "new", label: "Not already printed", count: funnel.not_printed ?? 0 },
      { step: "candidates", label: `Candidates (${CANDIDATES_PER_SECTION} per section)`, count: candidates.length },
      { step: "published", label: `Published (up to ${PUBLISHED_PER_SECTION} per section)`, count: published.length },
    ],
    sections, held_by_floor: held,
    totals: { sources: records.length, collected: items.length, published: published.length },
  };
  return map;
}

export async function writeEditionMap(db: Db, runId: string) {
  const map = await buildEditionMap(db, runId);
  if (map) await editionMaps(db).replaceOne({ _id: runId }, map, { upsert: true });
  return map;
}

export async function latestEditionMap(db: Db, locationId: string, editionId?: string | null) {
  if (editionId) return editionMaps(db).findOne({ _id: editionId, location_id: locationId, status: { $in: ["built", "published"] } });
  return editionMaps(db).find({ location_id: locationId, status: { $in: ["built", "published"] } }).sort({ published_at: -1 }).limit(1).next();
}
/** Finished editions' maps, built or published, for the map's edition picker. */
export async function editionMapList(db: Db, locationId: string) {
  return editionMaps(db).find({ location_id: locationId, status: { $in: ["built", "published"] } }, { projection: { _id: 1, published_at: 1, window: 1, status: 1 } }).sort({ published_at: -1 }).limit(20).toArray();
}
