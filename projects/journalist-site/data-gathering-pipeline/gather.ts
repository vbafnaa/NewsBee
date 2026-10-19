import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { ConfiguredSource } from "@/auth";
import type { PipelineRun, RawPipelineItem } from "./types";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 500;

function decode(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string) {
  const expression = new RegExp(`<(?:(?:[\\w.-]+):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${name}\\s*>`, "i");
  return expression.exec(block)?.[1] ?? "";
}

function linkFrom(block: string) {
  const raw = tag(block, "link");
  const atom = /<(?:(?:[\w.-]+):)?link\b[^>]*href=["']([^"']+)["']/i.exec(block)?.[1];
  const href = atom ?? raw;
  try {
    const url = new URL(decode(href));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function eventId(sourceId: string, sourceEventId: string, title: string, date: string) {
  return createHash("sha256").update(`${sourceId}\n${sourceEventId}\n${title}\n${date}`).digest("hex").slice(0, 24);
}

function asItem(
  source: ConfiguredSource,
  run: PipelineRun,
  id: string,
  title: string,
  date: string,
  description: string,
  url: string,
  venue: string,
  kind: string,
): RawPipelineItem | null {
  const normalizedTitle = decode(title);
  const parsedDate = new Date(date);
  const dateOnly = /^\d{4}-\d{2}-\d{2}/.test(date)
    ? date.slice(0, 10)
    : Number.isNaN(parsedDate.valueOf()) ? "" : parsedDate.toISOString().slice(0, 10);
  const link = url || source.url || "";
  if (!normalizedTitle || !/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
  try {
    const parsedLink = new URL(link);
    if (parsedLink.protocol !== "https:" || parsedLink.username || parsedLink.password) return null;
  } catch {
    return null;
  }
  return {
    id: eventId(source.id, id, normalizedTitle, dateOnly),
    title: normalizedTitle.slice(0, 500),
    description: decode(description).slice(0, 4000),
    event_date: dateOnly,
    published_at: date || undefined,
    source_url: link,
    venue: decode(venue).slice(0, 500) || null,
    kind,
    source_id: source.id,
    source_name: source.name,
  };
}

function parseFeed(
  source: ConfiguredSource,
  run: PipelineRun,
  xml: string,
  kind: "event" | "state_news",
): RawPipelineItem[] {
  const found: RawPipelineItem[] = [];
  const blocks = xml.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)\s*>/gi) ?? [];
  for (const block of blocks.slice(0, MAX_ITEMS)) {
    const title = tag(block, "title");
    const date = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") ||
      tag(block, "dc:date") || tag(block, "date");
    const summary = tag(block, "description") || tag(block, "summary") || tag(block, "content");
    const link = linkFrom(block);
    const id = tag(block, "guid") || tag(block, "id") || link;
    const item = asItem(source, run, id, title, date, summary, link, "", kind);
    if (item) found.push(item);
  }
  return found;
}

function parseIcal(source: ConfiguredSource, run: PipelineRun, text: string): RawPipelineItem[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];
  const found: RawPipelineItem[] = [];
  for (const block of blocks.slice(0, MAX_ITEMS)) {
    const value = (name: string) => new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "mi").exec(block)?.[1]?.trim() ?? "";
    const rawDate = value("DTSTART").replace(/[^0-9T]/g, "");
    const date = /^\d{8}/.test(rawDate)
      ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
      : "";
    const item = asItem(
      source, run, value("UID"), value("SUMMARY"), date, value("DESCRIPTION"),
      value("URL").startsWith("https://") ? value("URL") : "", value("LOCATION"), "event",
    );
    if (item) found.push(item);
  }
  return found;
}

function parseJsonLd(source: ConfiguredSource, run: PipelineRun, html: string) {
  const found: RawPipelineItem[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data: unknown = JSON.parse(match[1]);
      const values = Array.isArray(data) ? data : [data];
      for (const value of values) {
        if (typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
        if (!types.some((type) => type === "Event")) continue;
        const location = typeof record.location === "object" && record.location !== null
          ? (record.location as Record<string, unknown>).name : record.location;
        const item = asItem(
          source, run, String(record.url ?? record.name ?? ""), String(record.name ?? ""),
          String(record.startDate ?? ""), String(record.description ?? ""),
          typeof record.url === "string" && record.url.startsWith("https://") ? record.url : "",
          typeof location === "string" ? location : "", "event",
        );
        if (item) found.push(item);
      }
    } catch {
      continue;
    }
  }
  return found;
}

function isSafeSourceUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      isIP(url.hostname) === 0 &&
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()) &&
      !url.hostname.toLowerCase().endsWith(".local") &&
      !url.hostname.toLowerCase().endsWith(".internal");
  } catch {
    return false;
  }
}

async function fetchText(url: string, accept: string) {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!isSafeSourceUrl(current)) throw new Error("Source URL must be a public HTTPS address");
    const response = await fetch(current, {
      headers: { Accept: accept, "User-Agent": "Newsbee-Journalist/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const destination = response.headers.get("location");
      if (!destination || redirects === 3) throw new Error("Source returned too many redirects");
      current = new URL(destination, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Source response exceeds 2 MiB");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Source response exceeds 2 MiB");
    return { text: new TextDecoder().decode(bytes), finalUrl: current };
  }
  throw new Error("Source returned too many redirects");
}

async function libraryItems(source: ConfiguredSource, run: PipelineRun) {
  if (!source.url) throw new Error("Library source has no HTTPS website URL");
  const first = await fetchText(source.url, "application/rss+xml, application/atom+xml, application/xml, text/html");
  if (/<(?:item|entry)\b/i.test(first.text)) return parseFeed(source, run, first.text, "event");
  const calendarLink = /<link\b[^>]*type=["']text\/calendar["'][^>]*href=["']([^"']+)["']/i.exec(first.text)?.[1];
  const rssLink = /<link\b[^>]*type=["'][^"']*(?:rss|atom|xml)[^"']*["'][^>]*href=["']([^"']+)["']/i.exec(first.text)?.[1];
  const linked = calendarLink ?? rssLink;
  if (linked) {
    const url = new URL(linked, first.finalUrl).toString();
    const feed = await fetchText(url, "application/rss+xml, application/atom+xml, text/calendar, application/xml");
    return /\.ics(?:$|\?)/i.test(url) || /BEGIN:VCALENDAR/.test(feed.text)
      ? parseIcal(source, run, feed.text)
      : parseFeed(source, run, feed.text, "event");
  }
  return parseJsonLd(source, run, first.text);
}

async function newsroomItems(source: ConfiguredSource, run: PipelineRun) {
  if (!source.url) throw new Error("State newsroom source has no HTTPS feed URL");
  const { text } = await fetchText(source.url, "application/rss+xml, application/atom+xml, application/xml, text/xml");
  return parseFeed(source, run, text, "state_news");
}

function tenantFor(source: ConfiguredSource) {
  const tenant = source.tenant;
  if (!tenant || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant)) throw new Error("Government source has an invalid platform tenant");
  return tenant;
}

async function governmentItems(source: ConfiguredSource, run: PipelineRun) {
  const tenant = tenantFor(source);
  const first = run.period_start;
  const last = run.period_end;
  if (source.platform === "legistar") {
    const query = `EventDate ge datetime'${first}' and EventDate le datetime'${last}'`;
    const url = `https://webapi.legistar.com/v1/${tenant}/events?$filter=${encodeURIComponent(query)}&$orderby=EventDate`;
    const response = await fetchText(url, "application/json");
    const events: unknown = JSON.parse(response.text);
    if (!Array.isArray(events)) throw new Error("Legistar returned an invalid events response");
    const found: RawPipelineItem[] = [];
    for (const event of events.slice(0, 50)) {
      if (typeof event !== "object" || event === null) continue;
      const record = event as Record<string, unknown>;
      const eventId = String(record.EventId ?? "");
      const eventDate = String(record.EventDate ?? "");
      const body = String(record.EventBodyName ?? "Public meeting");
      const eventName = String(record.EventAgendaStatusName ?? "");
      if (!eventId || /cancel/i.test(`${eventName} ${String(record.EventComment ?? "")}`)) continue;
      const agenda = await fetchText(`https://webapi.legistar.com/v1/${tenant}/events/${encodeURIComponent(eventId)}/eventitems?Attachments=0`, "application/json");
      const items: unknown = JSON.parse(agenda.text);
      const agendaItems = Array.isArray(items) ? items.slice(0, 100) : [];
      const isPast = eventDate.slice(0, 10) < new Date().toISOString().slice(0, 10);
      const agendaLines = agendaItems.flatMap((agendaItem) => {
        if (typeof agendaItem !== "object" || agendaItem === null) return [];
        const item = agendaItem as Record<string, unknown>;
        const title = typeof item.EventItemTitle === "string" ? item.EventItemTitle.trim() : "";
        const matter = String(item.EventItemMatterType ?? "").trim().toLowerCase();
        if (!title || matter === "minutes" || /^(roll call|adjourn|public comment|draft agenda)/i.test(title)) return [];
        if (!isPast) return [title];
        const passed = String(item.EventItemPassedFlagName ?? "").trim().toLowerCase();
        const action = String(item.EventItemActionName ?? "").trim() ||
          (passed === "pass" ? "Passed" : passed === "fail" ? "Failed" : "");
        return action ? [`${title} (${action})`] : [];
      });
      if (isPast && !agendaLines.length) continue;
      const agendaTitles = agendaLines.slice(0, 8);
      const minutesFinal = String(record.EventMinutesStatusName ?? "").toLowerCase().startsWith("final");
      const description = isPast
        ? `Recorded outcomes: ${agendaTitles.join("; ")}. ${minutesFinal ? "These results come from the approved minutes." : "These results come from the clerk's meeting record; the official minutes are not yet approved."}`
        : agendaTitles.join("; ");
      const item = asItem(
        source, run, eventId, isPast ? `${body} decisions: ${agendaTitles[0]}` : body,
        eventDate, description,
        String(record.EventInSiteURL ?? "").startsWith("https://")
          ? String(record.EventInSiteURL) : `https://${tenant}.legistar.com/Calendar.aspx`,
        String(record.EventLocation ?? ""), isPast ? "meeting_outcome" : "meeting_preview",
      );
      if (item) found.push(item);
    }
    return found;
  }
  if (source.platform === "civicclerk") {
    const url = `https://${tenant}.api.civicclerk.com/v1/Events?$filter=${encodeURIComponent(`startDateTime ge ${first}T00:00:00Z and startDateTime le ${last}T23:59:59Z`)}&$orderby=startDateTime&$top=100`;
    const response = await fetchText(url, "application/json");
    const data: unknown = JSON.parse(response.text);
    const events = typeof data === "object" && data !== null && "value" in data
      ? (data as { value: unknown }).value : null;
    if (!Array.isArray(events)) throw new Error("CivicClerk returned an invalid events response");
    const found: RawPipelineItem[] = [];
    for (const event of events.slice(0, 50)) {
      if (typeof event !== "object" || event === null) continue;
      const record = event as Record<string, unknown>;
      if (!record.agendaId || !record.hasAgenda || record.isPublished !== "Published" ||
        /cancel/i.test(String(record.eventName ?? ""))) continue;
      const agenda = await fetchText(`https://${tenant}.api.civicclerk.com/v1/Meetings/${encodeURIComponent(String(record.agendaId))}`, "application/json");
      const meeting: unknown = JSON.parse(agenda.text);
      const titles: string[] = [];
      const visit = (items: unknown, depth: number) => {
        if (!Array.isArray(items) || depth > 4) return;
        for (const item of items) {
          if (typeof item !== "object" || item === null) continue;
          const current = item as Record<string, unknown>;
          if (Array.isArray(current.childItems) && current.childItems.length) visit(current.childItems, depth + 1);
          else if (typeof current.agendaObjectItemName === "string") titles.push(current.agendaObjectItemName);
        }
      };
      if (typeof meeting === "object" && meeting !== null) visit((meeting as Record<string, unknown>).items, 0);
      const venue = typeof record.eventLocation === "object" && record.eventLocation !== null
        ? `${String((record.eventLocation as Record<string, unknown>).address1 ?? "")}, ${String((record.eventLocation as Record<string, unknown>).city ?? "")}`
        : "";
      const item = asItem(
        source, run, String(record.id ?? ""), String(record.eventName ?? "Public meeting"),
        String(record.startDateTime ?? ""), titles.slice(0, 8).join("; "),
        `https://${tenant}.portal.civicclerk.com/event/${encodeURIComponent(String(record.id))}/overview`,
        venue, "meeting_preview",
      );
      if (item) found.push(item);
    }
    return found;
  }
  throw new Error("Unsupported government meeting platform");
}

export async function gatherSource(source: ConfiguredSource, run: PipelineRun) {
  const items = source.kind === "library" ? await libraryItems(source, run)
    : source.kind === "government" ? await governmentItems(source, run)
      : await newsroomItems(source, run);
  return {
    source_id: source.id,
    source_name: source.name,
    location_id: run.location_id,
    period_start: run.period_start,
    period_end: run.period_end,
    gathered_at: new Date().toISOString(),
    items,
  };
}
