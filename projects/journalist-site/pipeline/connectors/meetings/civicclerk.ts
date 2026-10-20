import { FeedFormatError, checkCount } from "../common";
import { bodyName, cancelled, itemTitle, type Meeting, type MeetingItem } from "./meetings";

export const API = "https://{tenant}.api.civicclerk.com/v1";
export const PORTAL = "https://{tenant}.portal.civicclerk.com/event/{event_id}/overview";
export const MAX_DEPTH = 4;
const encode = (query: string) => encodeURIComponent(query).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export function eventsUrl(tenant: string, first: string, lastExclusive: string) {
  const query = `startDateTime ge ${first}T00:00:00Z and startDateTime lt ${lastExclusive}T00:00:00Z`;
  return `${API.replace("{tenant}", tenant)}/Events?$filter=${encode(query)}&$orderby=startDateTime&$top=100`;
}
export function agendaUrl(tenant: string, id: number) { return `${API.replace("{tenant}", tenant)}/Meetings/${id}`; }
export function confirmUrl(tenant: string) { return `${API.replace("{tenant}", tenant)}/Events?$top=1`; }
function object(content: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(content)); } catch { throw new FeedFormatError("CivicClerk response is not JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new FeedFormatError("CivicClerk response is not an object");
  return parsed as Record<string, unknown>;
}
export function parseEvents(content: Uint8Array): Array<Record<string, unknown>> {
  const value = object(content).value;
  if (!Array.isArray(value)) throw new FeedFormatError("CivicClerk events response has no value list");
  checkCount(value.length);
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
}
export function start(event: Record<string, unknown>) {
  const value = String(event.startDateTime).replace(/Z$/, "").slice(0, 19);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new FeedFormatError("CivicClerk event has an invalid startDateTime");
  return { year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5] };
}
function* leaves(entries: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const children = item.childItems ?? [];
    if (Array.isArray(children) && children.length > 0 && depth < MAX_DEPTH) yield* leaves(children, depth + 1);
    else if (!item.isSection) yield item;
  }
}
export function items(content: Uint8Array): MeetingItem[] {
  const found = [...leaves(object(content).items ?? [])];
  checkCount(found.length);
  return found.flatMap((entry) => {
    const title = itemTitle(typeof entry.agendaObjectItemName === "string" ? entry.agendaObjectItemName : null);
    return title ? [{ title }] : [];
  });
}
export function venue(event: Record<string, unknown>): string | null {
  const place = event.eventLocation && typeof event.eventLocation === "object" ? event.eventLocation as Record<string, unknown> : {};
  const parts = [place.address1, place.city].filter((part): part is string => typeof part === "string" && Boolean(part.trim())).map((part) => part.trim());
  return parts.join(", ") || null;
}
export function usable(event: Record<string, unknown>) {
  return Boolean(event.agendaId && event.hasAgenda && event.isPublished === "Published" && !cancelled(typeof event.eventName === "string" ? event.eventName : null));
}
export async function meeting(tenant: string, event: Record<string, unknown>, get: (url: string) => Promise<Uint8Array>): Promise<Meeting> {
  const identity = Number(event.id);
  return {
    source_event_id: String(event.id),
    body: bodyName(String(event.eventName ?? "Public meeting")),
    start: start(event),
    venue: venue(event),
    source_url: PORTAL.replace("{tenant}", tenant).replace("{event_id}", String(identity)),
    items: items(await get(agendaUrl(tenant, Number(event.agendaId)))),
  };
}
