import type { Db } from "mongodb";
import type { SourceType } from "../connectors/types";
import { sourceMap, emptyHealth, type SourceRecord } from "./store";
import { isSection, type SectionId } from "./sections";
import type { SourceAccessReview } from "./source-review";
import { safeImageUrl } from "../../../../shared/story-image";

export const SHEET_CATALOG = "source_sheet_inventory";
export type SheetEntry = {
  id: string; number: number; name: string; url: string; communities: string[]; scope: string; section: string;
  checked_at: string; review_expires: string; decision: string; reason: string; evidence: string[];
  collection: { source_id: string; reader: string; params: Record<string, unknown>; allowed_urls: string[] } | null;
  [key: string]: unknown;
};
export type SheetInventory = { version: number; spreadsheet_url: string; spreadsheet_sha256: string;
  communities: Record<string, { id: string; name: string }>; sources: SheetEntry[] };

function approved(entry: SheetEntry) { return entry.decision === "approved_api" || entry.decision === "approved_feed"; }

/** Import the reviewed catalog without starting discovery, collection, authoring or publication. */
export async function importSheetInventory(db: Db, inventory: SheetInventory, apply = false) {
  if (inventory.version !== 1 || !inventory.sources.length || new Set(inventory.sources.map((item) => item.id)).size !== inventory.sources.length) throw new Error("Invalid source inventory");
  const today = new Date().toISOString().slice(0, 10);
  const readers = new Set(["web", "opendata", "library", "hazards", "justice"]);
  for (const entry of inventory.sources) {
    if (!safeImageUrl(entry.url) || !entry.communities.length || entry.communities.some((key) => !inventory.communities[key]) || !isSection(entry.section)) throw new Error(`Invalid inventory entry ${entry.id}`);
    if (entry.collection && !readers.has(entry.collection.reader)) throw new Error(`Invalid reader for ${entry.id}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.checked_at) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.review_expires)
      || entry.collection?.allowed_urls.some((url) => !safeImageUrl(url))) throw new Error(`Invalid review scope for ${entry.id}`);
    if (approved(entry) && (!entry.collection || entry.evidence.length < 2
      || entry.evidence.some((url) => !safeImageUrl(url)) || entry.checked_at > today || entry.review_expires < today
      || (entry.decision === "approved_feed" && !entry.collection.allowed_urls.length))) throw new Error(`Invalid approval evidence for ${entry.id}`);
  }
  const locationIds = [...new Set(Object.values(inventory.communities).map((community) => community.id))];
  const locations = await db.collection<{ _id: string; removal?: unknown }>("locations").find({ _id: { $in: locationIds } }).toArray();
  if (locations.length !== locationIds.length || locations.some((location) => location.removal)) throw new Error("Invalid source inventory: every community must be onboarded and available before importing");

  const groups = new Map<string, { locationId: string; entries: SheetEntry[] }>();
  for (const entry of inventory.sources) {
    // Shared documentation/provider rows remain in the catalog; only configured public APIs become tasks.
    if (!entry.collection || (entry.scope === "shared_integration" && !approved(entry))) continue;
    for (const community of entry.communities) {
      const locationId = inventory.communities[community].id;
      const key = `${locationId}:${entry.collection.source_id}`;
      const group = groups.get(key) ?? { locationId, entries: [] };
      group.entries.push(entry); groups.set(key, group);
    }
  }
  let added = 0, updated = 0, enabled = 0, held = 0;
  const perCommunity: Record<string, { total: number; enabled: number; held: number }> = {};
  const now = new Date().toISOString();
  for (const [_id, group] of groups) {
    const entries = group.entries.sort((a, b) => a.number - b.number);
    const entry = entries[0], configuration = entry.collection!;
    const allowed = entries.every(approved);
    const existing = await sourceMap(db).findOne({ _id });
    const review: SourceAccessReview = {
      inventory_ids: entries.map((item) => item.id), decision: entry.decision, collection_allowed: allowed,
      reason: entries.map((item) => item.reason).filter((value, i, all) => all.indexOf(value) === i).join(" "),
      evidence: [...new Set(entries.flatMap((item) => item.evidence))], checked_on: entry.checked_at,
      expires_on: entries.map((item) => item.review_expires).sort()[0], images_allowed: false,
      allowed_urls: allowed ? configuration.allowed_urls : [], collection_params: configuration.params,
      collection_reader: configuration.reader as SourceType,
    };
    const status = !allowed ? existing?.status === "rejected" ? "rejected" : "paused"
      : existing && ["paused", "rejected", "pinned"].includes(existing.status) ? existing.status : "active";
    const collecting = allowed && ["active", "pinned"].includes(status);
    const note = `Spreadsheet review ${entry.checked_at}: ${entry.decision}. ${review.reason} Photos are not approved by this review.`;
    const editorNote = existing?.note?.split(/(?:^|\n)Spreadsheet review /)[0].trim();
    const record: Partial<SourceRecord> = {
      location_id: group.locationId, source_id: configuration.source_id, name: existing?.name ?? entry.name,
      url: entry.url, reader: configuration.reader as SourceType, params: configuration.params,
      section: entry.section as SectionId, inside_area: false, link_only: !allowed, status,
      found_by: { method: "editor", detail: `Reviewed spreadsheet import: ${inventory.spreadsheet_url}; ${review.inventory_ids.join(", ")}` },
      access_review: review, note: editorNote ? `${editorNote}\n${note}` : note,
      last_seen: now,
    };
    if (apply) await sourceMap(db).updateOne({ _id }, { $set: record,
      $setOnInsert: { health: emptyHealth(), score: 0, first_seen: now, dormant_until: null } }, { upsert: true });
    existing ? updated++ : added++;
    collecting ? enabled++ : held++;
    const tally = perCommunity[group.locationId] ??= { total: 0, enabled: 0, held: 0 };
    tally.total++; collecting ? tally.enabled++ : tally.held++;
  }
  if (apply) for (const entry of inventory.sources) await db.collection<{ _id: string }>(SHEET_CATALOG).updateOne({ _id: entry.id }, {
    $set: { ...entry, spreadsheet_url: inventory.spreadsheet_url, spreadsheet_sha256: inventory.spreadsheet_sha256, imported_at: now },
  }, { upsert: true });
  return { applied: apply, catalog_entries: inventory.sources.length, added, updated, enabled, held, communities: perCommunity };
}
