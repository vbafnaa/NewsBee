/**
 * Editor source links and reader suggestions, both of which end up on the source map.
 *
 *   - An editor adds a link in the journalist portal: a website or feed, an open-data
 *     dataset, a library catalogue or a meeting platform. The link is read once with its
 *     reader before it is saved; unusable links are rejected without saving.
 *   - A reader suggests a source on the reader site: it waits in the editor Inbox, and joins
 *     the map (after the same check) only when an editor approves it.
 *
 * Library and meeting links keep a record in `location_source_links`, which their readers
 * read; earlier links of other kinds are moved onto the map by `migrateManualLinks`.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import { fetchTransport, type HttpTransport } from "../core/http";
import { logger } from "../core/log";
import { ingestWindow, localToday } from "../core/time";
import { getLocation } from "../communities/locations";
import { COLLECTIONS } from "../storage/mongo";
import { MongoLinkCache } from "../storage/link-cache";
import { Fetcher } from "./fetcher";
import { publicSourceTransport } from "./public-http";
import { collectLibraryLink } from "./library";
import { collectMeetingLink } from "./meetings";
import { webConnector } from "./web";
import { openDataConnector, TOPIC_SECTION, type Topic } from "./opendata";
import type { CollectedSource, ConnectorContext, GovernmentSource, SourceTask } from "./types";
import { isSection, type SectionId } from "../sourcemap/sections";
import { sourceMap, upsertCandidates, webSourceId, type DiscoveryMethod, type SourceCandidate } from "../sourcemap/store";

export const MANUAL_CONNECTORS = ["library", "meetings"] as const;
export const LINK_TYPES = ["web", "opendata", "library", "meetings"] as const;
export type LinkType = typeof LINK_TYPES[number];
export type ManualConnector = typeof MANUAL_CONNECTORS[number] | "statenews" | "justice" | "localsites" | "athletics" | "business" | "remembrance";
export type ManualLink = {
  _id: string; location_id: string; connector: ManualConnector; name: string; url: string;
  system_id: string | null; government: GovernmentSource | null; feed_kind: string | null; feed_url: string | null;
  created_at: string; validated_at: string; validated_events: number;
  note?: string | null;
};
export class InvalidSourceLink extends Error {}

export function manualTask(link: ManualLink): SourceTask {
  return { type: link.connector as "library" | "meetings", source_id: `${link.connector}:manual:${link._id}`, name: link.name, params: { manual_link_id: link._id } };
}

function governmentLink(url: string): GovernmentSource {
  const parsed = new URL(url);
  const legistar = /^([a-z0-9-]+)\.legistar\.com$/i.exec(parsed.hostname);
  const civic = /^([a-z0-9-]+)\.(?:portal|api)\.civicclerk\.com$/i.exec(parsed.hostname);
  const apiTenant = parsed.hostname === "webapi.legistar.com" ? /^\/v1\/([a-z0-9-]+)(?:\/|$)/i.exec(parsed.pathname)?.[1] : null;
  const tenant = civic?.[1] ?? legistar?.[1] ?? apiTenant;
  if (!tenant || ["webapi", "www", "api", "portal"].includes(tenant)) throw new InvalidSourceLink("Use a supported Legistar or CivicClerk tenant link");
  return { status: "override", platform: civic ? "civicclerk" : "legistar", tenant: tenant.toLowerCase(), website: url, wikidata_id: null, pages_checked: [url], detail: "Editor-supplied link, validated before saving" };
}

export async function collectManualLink(link: ManualLink, context: ConnectorContext): Promise<CollectedSource> {
  const transport = publicSourceTransport(context.transport);
  const safe = { ...context, transport, fetcher: new Fetcher(transport), model: undefined };
  let collected: CollectedSource;
  if (link.connector === "library") {
    const system = context.location.systems.find((item) => item.fscskey === link.system_id);
    if (!system) throw new InvalidSourceLink("The selected library system no longer belongs to this location");
    collected = (await collectLibraryLink(safe, link.url, system)).collected;
  } else if (link.connector === "meetings") {
    if (!link.government) throw new InvalidSourceLink("The meeting link has no validated platform");
    collected = await collectMeetingLink(safe, link.government);
  } else {
    throw new InvalidSourceLink("This earlier link has moved to the source map");
  }
  return { ...collected, result: { ...collected.result, source_id: manualTask(link).source_id, name: link.name } };
}

export function manualLinks(db: Db) {
  return db.collection<ManualLink>(COLLECTIONS.manualLinks);
}

function datasetFromUrl(url: string) {
  const match = /^https:\/\/([a-z0-9.-]+)\/(?:d\/|resource\/|.*\/)([a-z0-9]{4}-[a-z0-9]{4})/i.exec(url);
  if (!match) throw new InvalidSourceLink("Use a Socrata dataset link such as https://data.example.gov/d/abcd-1234");
  return { domain: match[1].toLowerCase(), dataset: match[2].toLowerCase() };
}

/** Kinds for website links by section: obituaries are notices, newsrooms are reports. */
function webKind(section: SectionId, value: unknown) {
  if (typeof value === "string" && ["local_news", "news_report", "obituary", "school_sports"].includes(value)) return value;
  return section === "obituaries" ? "obituary" : section === "news" ? "news_report" : "local_news";
}

function checkedUrl(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 2000) throw new InvalidSourceLink("Enter a public HTTPS source link");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new InvalidSourceLink("Enter a valid public HTTPS source link"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new InvalidSourceLink("Enter a public HTTPS source link without credentials");
  url.hash = "";
  return url.toString();
}

/** The longest "How did you find it?" note kept. */
export const MAX_HOW_FOUND = 300;

/**
 * Validate and save a source link for a location. Returns the source-map record id.
 * `method` is "editor" for portal links and "reader_suggestion" for approved suggestions.
 */
export async function addSourceLink(db: Db, settings: Settings, locationId: string, input: unknown, transport: HttpTransport = fetchTransport, method: DiscoveryMethod = "editor") {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidSourceLink("Source link must be a JSON object");
  const values = input as Record<string, unknown>;
  const legacy: Record<string, LinkType> = { statenews: "web", justice: "web", localsites: "web", athletics: "web", remembrance: "web", business: "opendata" };
  const type = LINK_TYPES.find((kind) => kind === values.type) ?? LINK_TYPES.find((kind) => kind === values.connector) ?? (typeof values.connector === "string" ? legacy[values.connector] : undefined) ?? "web";
  const name = typeof values.name === "string" ? values.name.trim() : "";
  if (!name || name.length > 120) throw new InvalidSourceLink("Enter a source name of 1-120 characters");
  const url = checkedUrl(values.url);
  const note = typeof values.note === "string" ? values.note.trim().slice(0, 500) : "";
  // Optional: how the person found it, kept with how it was found so research habits can go into the playbook.
  const howFound = typeof values.how_found === "string" ? values.how_found.replace(/\s+/g, " ").trim().slice(0, MAX_HOW_FOUND) : "";
  const section: SectionId = isSection(values.section) ? values.section : values.connector === "remembrance" ? "obituaries" : values.connector === "athletics" ? "sports" : values.connector === "justice" ? "safety" : "news";
  if (section === "obituaries" && note.length < 10) throw new InvalidSourceLink("Record how the funeral home or publisher gave permission to republish its notices");
  const location = await getLocation(db, locationId);
  const today = localToday(location.state);
  const context: ConnectorContext = { db, settings, location, transport: publicSourceTransport(transport), fetcher: new Fetcher(publicSourceTransport(transport)), today, window: ingestWindow(today),
    linkCache: new MongoLinkCache(db), log: logger("source-links", { location_id: locationId }) };
  let candidate: SourceCandidate;
  let preview: CollectedSource;
  try {
    if (type === "web") {
      const kind = webKind(section, values.connector === "remembrance" ? "obituary" : values.kind);
      candidate = { source_id: webSourceId(url), name, url, feed_url: null, reader: "web", params: { url, kind, section, inside_area: values.inside_area === true }, section, found_by: { method, detail: method === "editor" ? "Added by an editor in the journalist portal" : "Suggested by a reader, approved by an editor", ...(howFound ? { how_found: howFound } : {}) }, inside_area: values.inside_area === true, note: note || null };
      preview = await webConnector.collect({ type: "web", source_id: candidate.source_id, name, params: candidate.params }, context);
    } else if (type === "opendata") {
      const { domain, dataset } = datasetFromUrl(url);
      const topic = (["police", "fire", "permits", "inspections", "licences", "311"].includes(String(values.topic)) ? values.topic : values.connector === "business" ? "licences" : "permits") as Topic;
      candidate = { source_id: `opendata:${domain}:${dataset}`, name, url: `https://${domain}/d/${dataset}`, reader: "opendata", params: { domain, dataset, topic, filter: values.filter === "city" ? "city" : "radius", agency: name }, section: TOPIC_SECTION[topic] as SectionId, found_by: { method, detail: "Added by an editor in the journalist portal", ...(howFound ? { how_found: howFound } : {}) }, inside_area: false, note: note || null };
      preview = await openDataConnector.collect({ type: "opendata", source_id: candidate.source_id, name, params: candidate.params }, context);
    } else {
      const created = new Date().toISOString();
      const link: ManualLink = {
        _id: randomUUID(), location_id: locationId, connector: type, name, url,
        system_id: typeof values.system_id === "string" ? values.system_id : null,
        government: type === "meetings" ? governmentLink(url) : null,
        feed_kind: null, feed_url: null, created_at: created, validated_at: created, validated_events: 0, note: note || null,
      };
      preview = await collectManualLink(link, context);
      if (preview.result.status === "ingested") {
        link.feed_kind = preview.result.feed_kind; link.feed_url = preview.result.feed_url; link.validated_events = preview.events.length;
        await manualLinks(db).insertOne(link);
      }
      const task = manualTask(link);
      candidate = { source_id: task.source_id, name, url, reader: type, params: { manual_link_id: link._id }, section: type === "library" ? "events" : "civic", found_by: { method, detail: "Added by an editor in the journalist portal", ...(howFound ? { how_found: howFound } : {}) }, inside_area: type === "library", note: note || null };
    }
  } catch (error) {
    if (error instanceof InvalidSourceLink) throw error;
    context.log.warn("source_link_validation_failed", { url, type, error: String(error) });
    throw new InvalidSourceLink(`Link could not be validated: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (preview.result.status !== "ingested") throw new InvalidSourceLink(`Link is not usable: ${preview.result.detail}`);
  const labelled = await sourceMap(db).findOne({ _id: `${locationId}:${candidate.source_id}` }, { projection: { review: 1 } });
  if (labelled?.review?.decision === "reject") throw new InvalidSourceLink("This source was rejected. Change its Decision in the source network to use it again.");
  if (await sourceMap(db).findOne({ _id: `${locationId}:${candidate.source_id}`, found_by: { $exists: true }, status: { $ne: "rejected" } })) {
    await sourceMap(db).updateOne({ _id: `${locationId}:${candidate.source_id}` }, { $set: { status: "pinned", found_by: candidate.found_by, ...(note ? { note } : {}) } });
  } else {
    await upsertCandidates(db, locationId, [{ ...candidate, status: "pinned" }]);
    await sourceMap(db).updateOne({ _id: `${locationId}:${candidate.source_id}` }, { $set: { status: "pinned", found_by: candidate.found_by } });
  }
  context.log.info("source_link_saved", { source_id: candidate.source_id, type, events: preview.events.length, method });
  return { source_id: candidate.source_id, validated_events: preview.events.length, detail: preview.result.detail };
}

/** Moves earlier editor links (other than library and meeting links) onto the source map, once. */
export async function migrateManualLinks(db: Db, locationId: string) {
  const links = await manualLinks(db).find({ location_id: locationId }).toArray();
  const candidates: SourceCandidate[] = [];
  for (const link of links) {
    if (link.connector === "library" || link.connector === "meetings") {
      const task = manualTask(link);
      candidates.push({ source_id: task.source_id, name: link.name, url: link.url, reader: link.connector, params: { manual_link_id: link._id }, section: link.connector === "library" ? "events" : "civic", found_by: { method: "migrated", detail: "Earlier editor link" }, inside_area: link.connector === "library", status: "pinned" });
      continue;
    }
    if (link.connector === "business") {
      try {
        const { domain, dataset } = datasetFromUrl(link.url);
        candidates.push({ source_id: `opendata:${domain}:${dataset}`, name: link.name, url: link.url, reader: "opendata", params: { domain, dataset, topic: "licences", filter: "city", agency: link.name }, section: "business", found_by: { method: "migrated", detail: "Earlier editor link" }, inside_area: false, status: "pinned" });
      } catch { /* not a dataset link */ }
      continue;
    }
    const section: SectionId = link.connector === "remembrance" ? "obituaries" : link.connector === "athletics" ? "sports" : link.connector === "justice" ? "safety" : link.connector === "localsites" ? "community" : "news";
    candidates.push({ source_id: webSourceId(link.url), name: link.name, url: link.url, reader: "web", params: { url: link.url, kind: webKind(section, null), section, inside_area: link.connector === "localsites" }, section, found_by: { method: "migrated", detail: `Earlier ${link.connector} link` }, inside_area: link.connector === "localsites", status: "pinned", note: link.note ?? null });
  }
  if (candidates.length) await upsertCandidates(db, locationId, candidates);
  // Only library and meeting links are still read from here.
  await manualLinks(db).deleteMany({ location_id: locationId, connector: { $nin: ["library", "meetings"] } });
  return candidates.length;
}

// --- reader suggestions -----------------------------------------------------------------------
export const SOURCE_SUGGESTIONS = "source_suggestions";
export type SourceSuggestion = { _id: string; location_id: string; location_name: string; name: string; url: string; section: SectionId; why: string | null; status: "pending" | "approved" | "rejected"; submitted_at: string; decided_at?: string | null; decided_by?: string | null; reason?: string | null; source_id?: string | null };
export function sourceSuggestions(db: Db) { return db.collection<SourceSuggestion>(SOURCE_SUGGESTIONS); }
export async function listSuggestions(db: Db, status: SourceSuggestion["status"] | "all" = "pending", locationId?: string) {
  return sourceSuggestions(db).find({ ...(status === "all" ? {} : { status }), ...(locationId ? { location_id: locationId } : {}) }).sort({ submitted_at: -1 }).limit(200).toArray();
}
export async function decideSuggestion(db: Db, settings: Settings, id: string, decision: "approved" | "rejected", editor: string, reason?: string, transport: HttpTransport = fetchTransport) {
  const suggestion = await sourceSuggestions(db).findOne({ _id: id });
  if (!suggestion) throw new Error(`Unknown suggestion: ${id}`);
  let sourceId: string | null = null;
  if (decision === "approved") {
    const saved = await addSourceLink(db, settings, suggestion.location_id, { type: "web", name: suggestion.name, url: suggestion.url, section: suggestion.section, note: suggestion.section === "obituaries" ? `Reader suggestion approved by ${editor}` : undefined }, transport, "reader_suggestion");
    sourceId = saved.source_id;
  }
  await sourceSuggestions(db).updateOne({ _id: id }, { $set: { status: decision, decided_at: new Date().toISOString(), decided_by: editor, reason: reason ?? null, source_id: sourceId } });
  return { ...suggestion, status: decision, source_id: sourceId };
}
