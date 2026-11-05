/**
 * Active National Weather Service alerts for the location's point (api.weather.gov, public
 * domain, no key). One story per alert type, keeping the newest issue of each, so a
 * warning that is updated five times appears once with its latest wording.
 */
import { plainText } from "../common";
import { sourceResult, type CollectedEvent, type CollectedSource, type ConnectorContext, type SourceTask } from "../types";
import { publishedText } from "./adapters";
import { publicApiGet } from "../public-api";

export const NWS_ALERTS = "https://api.weather.gov/alerts/active";
export const ACCEPT_GEOJSON = "application/geo+json";
export const MAX_ALERTS = 4;
const SEVERITY: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

export type NwsAlert = {
  id: string; event: string; headline: string | null; description: string | null; instruction: string | null;
  severity: string; urgency: string; area: string; sent: string; effective: string | null; ends: string | null; sender: string;
};

export function nwsUrl(latitude: number, longitude: number) {
  return `${NWS_ALERTS}?point=${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}
export function forecastPage(latitude: number, longitude: number) {
  return `https://forecast.weather.gov/MapClick.php?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`;
}

export function parseNws(value: unknown): NwsAlert[] {
  const features = (value as { features?: Array<{ properties?: Record<string, unknown> }> })?.features;
  if (!Array.isArray(features)) throw new Error("Weather Service response has no features");
  const alerts: NwsAlert[] = [];
  for (const feature of features) {
    const p = feature.properties ?? {};
    if (p.status !== "Actual" || !["Alert", "Update"].includes(String(p.messageType))) continue;
    if (typeof p.id !== "string" || typeof p.event !== "string" || typeof p.sent !== "string") continue;
    alerts.push({
      id: p.id, event: p.event, headline: typeof p.headline === "string" ? p.headline : null,
      description: typeof p.description === "string" ? p.description : null, instruction: typeof p.instruction === "string" ? p.instruction : null,
      severity: typeof p.severity === "string" ? p.severity : "Unknown", urgency: typeof p.urgency === "string" ? p.urgency : "Unknown",
      area: typeof p.areaDesc === "string" ? p.areaDesc : "", sent: p.sent, effective: typeof p.effective === "string" ? p.effective : null,
      ends: typeof p.ends === "string" ? p.ends : typeof p.expires === "string" ? p.expires : null,
      sender: typeof p.senderName === "string" ? p.senderName : "National Weather Service",
    });
  }
  return alerts;
}

/** NWS products are written in capitals and hard-wrapped; make them readable sentences. */
function readable(text: string | null, limit: number) {
  if (!text) return null;
  const joined = text.replace(/\n(?!\n)/g, " ").replace(/\*\s*(WHAT|WHERE|WHEN|IMPACTS|ADDITIONAL DETAILS)\.\.\./g, "$1: ");
  const cased = /[a-z]/.test(joined) ? joined : joined.toLowerCase().replace(/(^|[.!?]\s+)([a-z])/g, (_, gap: string, letter: string) => gap + letter.toUpperCase());
  return plainText(cased, limit);
}
const day = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

export function alertFacts(alert: NwsAlert, town: string, latitude: number, longitude: number): CollectedEvent {
  const issued = day(alert.sent)!;
  const ends = day(alert.ends);
  let description = `The National Weather Service (${alert.sender}) issued a ${alert.event}${alert.area ? ` covering ${alert.area}` : ""}`;
  description += ends ? `, in effect until ${publishedText(ends)}.` : ".";
  const body = readable(alert.description, 700);
  if (body) description += ` ${body}`;
  const instruction = readable(alert.instruction, 300);
  if (instruction) description += ` The Weather Service advises: ${instruction}`;
  return {
    source_event_id: alert.id, title: `${alert.event} for the ${town} area`, event_date: issued, schedule_text: publishedText(issued),
    venue: "National Weather Service", room: null, source_url: forecastPage(latitude, longitude), description: plainText(description, 1500) ?? description,
    kind: "weather_alert", tier: "local", section: "Weather alerts",
    signals: { severity: SEVERITY[alert.severity] ?? 0, urgent: alert.urgency === "Immediate" || alert.urgency === "Expected" ? 1 : 0 },
  } as CollectedEvent;
}

export async function collectWeather(task: SourceTask, context: ConnectorContext, latitude: number, longitude: number, town: string): Promise<CollectedSource> {
  const url = nwsUrl(latitude, longitude);
  const record = sourceResult(task.source_id, task.name, "ingested", "", { feed_kind: "nws_alerts", feed_url: url, website: forecastPage(latitude, longitude) });
  const body = await publicApiGet(context.transport, url, ACCEPT_GEOJSON, 2 * 1024 * 1024);
  const alerts = parseNws(JSON.parse(new TextDecoder().decode(body)));
  const newest = new Map<string, NwsAlert>();
  for (const alert of alerts) {
    const seen = newest.get(alert.event);
    if (!seen || alert.sent > seen.sent) newest.set(alert.event, alert);
  }
  const kept = [...newest.values()].sort((a, b) => (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0) || b.sent.localeCompare(a.sent)).slice(0, MAX_ALERTS);
  const events = kept.map((alert) => alertFacts(alert, town, latitude, longitude));
  record.event_count = events.length;
  record.skipped_unusable = Object.fromEntries(Object.entries({ updated_alert: alerts.length - newest.size, item_limit: newest.size - kept.length }).filter(([, n]) => n > 0));
  record.detail = `${alerts.length} active Weather Service alerts for ${town}; ${events.length} kept`;
  return { result: record, events };
}
