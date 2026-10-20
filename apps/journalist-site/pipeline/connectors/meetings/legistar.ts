import { FeedFormatError, checkCount, httpsLink } from "../common";
import type { HttpTransport } from "../../core/http";
import { bodyName, cancelled, itemTitle, type Meeting, type MeetingItem } from "./meetings";

export const API = "https://webapi.legistar.com/v1";
const WEIGHTS: Record<string, number> = { ordinance: 3, "public hearing": 3, resolution: 2, appointment: 1 };
const SKIPPED_MATTERS = new Set(["minutes"]);
const PASSED: Record<string, string> = { pass: "Passed", fail: "Failed" };
const encode = (query: string) => encodeURIComponent(query).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export function eventsUrl(tenant: string, first: string, last: string) {
  const query = `EventDate ge datetime'${first}' and EventDate le datetime'${last}'`;
  return `${API}/${tenant}/events?$filter=${encode(query)}&$orderby=EventDate`;
}
export function itemsUrl(tenant: string, id: number) { return `${API}/${tenant}/events/${id}/eventitems?Attachments=0`; }
export function confirmUrl(tenant: string) { return `${API}/${tenant}/bodies?$top=1`; }
function list(content: Uint8Array): Array<Record<string, unknown>> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(content)); } catch { throw new FeedFormatError("Legistar response is not JSON"); }
  if (!Array.isArray(parsed)) throw new FeedFormatError("Legistar response is not a list");
  checkCount(parsed.length);
  return parsed.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
}
export function parseEvents(content: Uint8Array) { return list(content); }
export function start(event: Record<string, unknown>) {
  const value = String(event.EventDate);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const parsed = /^(\d{1,2}):(\d{2})\s+(AM|PM)$/i.exec(String(event.EventTime ?? "").trim());
  if (!parsed) return { year, month, day };
  let hour = Number(parsed[1]) % 12;
  if (parsed[3].toUpperCase() === "PM") hour += 12;
  return { year, month, day, hour, minute: Number(parsed[2]) };
}
export function items(content: Uint8Array): MeetingItem[] {
  return list(content).sort((a, b) => Number(a.EventItemAgendaSequence ?? 0) - Number(b.EventItemAgendaSequence ?? 0)).flatMap((entry) => {
    const matter = String(entry.EventItemMatterType ?? "").trim().toLowerCase();
    const raw = String(entry.EventItemTitle ?? "");
    if (SKIPPED_MATTERS.has(matter) || (!matter && raw === raw.toLocaleUpperCase("und"))) return [];
    const title = itemTitle(raw);
    if (!title) return [];
    const passed = String(entry.EventItemPassedFlagName ?? "").trim().toLowerCase();
    const action = itemTitle(typeof entry.EventItemActionName === "string" ? entry.EventItemActionName : null) ?? PASSED[passed];
    return [{ title, consent: Boolean(entry.EventItemConsent), weight: (WEIGHTS[matter] ?? (matter ? 1 : 0)) + Number(Object.hasOwn(PASSED, passed)), outcome: action ?? null }];
  });
}
export async function meeting(tenant: string, event: Record<string, unknown>, get: (url: string) => Promise<Uint8Array>): Promise<Meeting> {
  const status = String(event.EventAgendaStatusName ?? "");
  const eventId = Number(event.EventId);
  return {
    source_event_id: String(event.EventId),
    body: bodyName(String(event.EventBodyName ?? "Public meeting")),
    start: start(event),
    venue: typeof event.EventLocation === "string" ? event.EventLocation : null,
    source_url: httpsLink(typeof event.EventInSiteURL === "string" ? event.EventInSiteURL : null) ?? `https://${tenant}.legistar.com/Calendar.aspx`,
    items: items(await get(itemsUrl(tenant, eventId))),
    draft_agenda: status.toLowerCase().includes("draft"),
    minutes_final: String(event.EventMinutesStatusName ?? "").toLowerCase().startsWith("final"),
    note: typeof event.EventComment === "string" ? event.EventComment : null,
  };
}
export function isCancelled(event: Record<string, unknown>) {
  return cancelled(String(event.EventAgendaStatusName ?? ""), typeof event.EventComment === "string" ? event.EventComment : null, String(event.EventBodyName ?? ""));
}
export async function confirm(transport: HttpTransport, tenant: string, get: (url: string) => Promise<Uint8Array>) {
  return parseEvents(await get(confirmUrl(tenant))).length > 0;
}
