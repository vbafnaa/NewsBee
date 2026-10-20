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
import { stateNewsConnector } from "./wider";
import type { CollectedSource, ConnectorContext, GovernmentSource, SourceTask } from "./types";

export const MANUAL_CONNECTORS = ["library", "meetings", "statenews"] as const;
export type ManualConnector = typeof MANUAL_CONNECTORS[number];
export type ManualLink = {
  _id: string; location_id: string; connector: ManualConnector; name: string; url: string;
  system_id: string | null; government: GovernmentSource | null; feed_kind: string | null; feed_url: string | null;
  created_at: string; validated_at: string; validated_events: number;
};
export class InvalidSourceLink extends Error {}

export function manualTask(link: ManualLink): SourceTask {
  return { type: link.connector, source_id: `${link.connector}:manual:${link._id}`, name: link.name, params: { manual_link_id: link._id } };
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
    collected = await stateNewsConnector.collect({ ...manualTask(link), params: { manual_feed: link.url } }, safe);
  }
  return { ...collected, result: { ...collected.result, source_id: manualTask(link).source_id, name: link.name } };
}

export function manualLinks(db: Db) {
  return db.collection<ManualLink>(COLLECTIONS.manualLinks);
}

export async function addManualLink(db: Db, settings: Settings, locationId: string, input: unknown, transport: HttpTransport = fetchTransport) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidSourceLink("Source link must be a JSON object");
  const values = input as Record<string, unknown>;
  const connector = MANUAL_CONNECTORS.find((kind) => kind === values.connector);
  if (!connector) throw new InvalidSourceLink("Choose an existing library, meetings or state-news connector");
  if (typeof values.name !== "string" || !values.name.trim() || values.name.trim().length > 120) throw new InvalidSourceLink("Enter a source name of 1-120 characters");
  if (typeof values.url !== "string" || values.url.length > 2000) throw new InvalidSourceLink("Enter a public HTTPS source link");
  let url: URL;
  try { url = new URL(values.url.trim()); } catch { throw new InvalidSourceLink("Enter a valid public HTTPS source link"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new InvalidSourceLink("Enter a public HTTPS source link without credentials");
  url.hash = "";
  const location = await getLocation(db, locationId);
  const created = new Date().toISOString();
  const link: ManualLink = {
    _id: randomUUID(), location_id: locationId, connector, name: values.name.trim(), url: url.toString(),
    system_id: typeof values.system_id === "string" ? values.system_id : null,
    government: connector === "meetings" ? governmentLink(url.toString()) : null,
    feed_kind: null, feed_url: null, created_at: created, validated_at: created, validated_events: 0,
  };
  const today = localToday(location.state);
  const context: ConnectorContext = { db, settings, location, transport, fetcher: new Fetcher(transport), today, window: ingestWindow(today),
    linkCache: new MongoLinkCache(db), log: logger("manual-links", { location_id: locationId }) };
  let preview: CollectedSource;
  try { preview = await collectManualLink(link, context); }
  catch (error) {
    context.log.warn("manual_link_validation_failed", { url: link.url, connector, error: String(error) });
    throw new InvalidSourceLink(`Link could not be validated: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (preview.result.status !== "ingested") {
    context.log.warn("manual_link_validation_failed", { url: link.url, connector, status: preview.result.status, detail: preview.result.detail });
    throw new InvalidSourceLink(`Link is not usable by this connector: ${preview.result.detail}`);
  }
  link.feed_kind = preview.result.feed_kind;
  link.feed_url = preview.result.feed_url;
  link.validated_events = preview.events.length;
  link.validated_at = new Date().toISOString();
  const collection = manualLinks(db);
  await collection.createIndex({ location_id: 1, connector: 1, url: 1 }, { unique: true });
  try { await collection.insertOne(link); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === 11000) throw new InvalidSourceLink("This link is already saved for the location and connector");
    throw error;
  }
  context.log.info("manual_link_saved", { id: link._id, connector, events: link.validated_events });
  return link;
}
