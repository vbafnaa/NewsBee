/** Port of connectors/common.py: shared event facts and safety limits for every source parser. */
import { Parser } from "htmlparser2";
import { decodeHTML } from "entities";

export const MAX_FEED_BYTES = 4 * 1024 * 1024;
export const MAX_FEED_ITEMS = 500;
export const DESCRIPTION_MAX = 1500;

/**
 * Fields retained from a source. Wider-area connectors add `kind`, `tier`, `signals` and other
 * fields, exactly like the Python dicts (`{**event.model_dump(), ...}`).
 */
export type EventFacts = {
  source_event_id: string;
  title: string;
  event_date: string;
  schedule_text: string;
  venue: string;
  venue_url?: string | null;
  room?: string | null;
  source_url: string;
  description?: string | null;
  kind?: string;
  [extra: string]: unknown;
};

export class FeedFormatError extends Error {}

const CANCELLED_TITLE = /\bcancel+ed\b/i;
/** Libraries often keep cancelled events in their feeds, marked only in the title (e.g. "CANCELLED: Storytime"). */
export function cancelledTitle(title: unknown) { return typeof title === "string" && CANCELLED_TITLE.test(title); }

const BREAKS = new Set(["br", "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "tr"]);

function htmlParts(value: string) {
  const parts: string[] = [];
  const parser = new Parser(
    {
      onopentagname(name) {
        if (BREAKS.has(name)) parts.push("\n");
      },
      onclosetag(name, implied) {
        if (BREAKS.has(name) && !implied) parts.push("\n");
      },
      ontext(data) {
        parts.push(data);
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(value);
  parser.end();
  return parts.join("");
}

/** HTML or text -> single-spaced sentences, cut at a word boundary within `limit`. */
export function plainText(value: unknown, limit = DESCRIPTION_MAX): string | null {
  if (!value || typeof value !== "string") return null;
  const source = value.includes("<") ? value : decodeHTML(value);
  const lines = htmlParts(source)
    .split(/\r\n|\r|\n/)
    .map((line) => line.split(/\s+/).filter(Boolean).join(" "));
  let text = lines
    .filter((line) => line.replace(/^[ .]+|[ .]+$/g, ""))
    .map((line) => (".!?:;".includes(line[line.length - 1]) ? line : `${line}.`))
    .join(" ");
  if (text.length > limit) {
    const cut = text.slice(0, limit);
    const space = cut.lastIndexOf(" ");
    text = `${(space >= 0 ? cut.slice(0, space) : cut).replace(/[,;:]+$/, "")}...`;
  }
  return text || null;
}

export function checkSize(content: Uint8Array | string) {
  const size = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
  if (size > MAX_FEED_BYTES) throw new FeedFormatError("Feed exceeds the 4 MiB ingestion limit");
}

export function checkCount(count: number) {
  if (count > MAX_FEED_ITEMS) {
    throw new FeedFormatError(`Feed exceeds the ${MAX_FEED_ITEMS}-item ingestion limit`);
  }
}

export function rejectUnsafeXml(content: Uint8Array | string) {
  const value = typeof content === "string" ? content : Buffer.from(content).toString("latin1");
  // Rejecting NULs also prevents UTF-16 bypasses of the declaration check.
  if (value.includes("\u0000") || /<!\s*(DOCTYPE|ENTITY)\b/i.test(value)) {
    throw new FeedFormatError("DTD/entity declarations and NUL bytes are not supported");
  }
}

export function httpsLink(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) {
      // Python returns urlsplit(...).geturl(); keep the source's own spelling.
      return raw;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * A wall-clock moment in the source's own local time (Python date or naive/aware datetime).
 * `hour`/`minute` absent means an all-day date.
 */
export type LocalMoment = { year: number; month: number; day: number; hour?: number; minute?: number };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function weekday(moment: LocalMoment) {
  return WEEKDAYS[new Date(Date.UTC(moment.year, moment.month - 1, moment.day)).getUTCDay()];
}

export function monthName(month: number) {
  return MONTHS[month - 1];
}

export function isoDate(moment: LocalMoment) {
  return `${String(moment.year).padStart(4, "0")}-${String(moment.month).padStart(2, "0")}-${String(moment.day).padStart(2, "0")}`;
}

export function parseIsoDate(value: string): LocalMoment {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) throw new Error(`Invalid ISO date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function clock(moment: LocalMoment) {
  const hour = moment.hour ?? 0;
  const minute = moment.minute ?? 0;
  const shown = hour % 12 || 12;
  const minutes = minute ? `:${String(minute).padStart(2, "0")}` : "";
  return `${shown}${minutes}${hour < 12 ? "am" : "pm"}`;
}

function hasTime(moment: LocalMoment | null | undefined): moment is LocalMoment & { hour: number } {
  return Boolean(moment && moment.hour !== undefined);
}

function after(left: LocalMoment, right: LocalMoment) {
  const key = (m: LocalMoment) => [m.year, m.month, m.day, m.hour ?? 0, m.minute ?? 0];
  const a = key(left);
  const b = key(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

/** Describe the published start and end exactly, in the source's own local time. */
export function scheduleText(start: LocalMoment, end?: LocalMoment | null) {
  let result = `${weekday(start)}, ${monthName(start.month)} ${start.day}, ${start.year}`;
  if (hasTime(start)) {
    result += `, ${clock(start)}`;
    if (hasTime(end) && after(end, start)) {
      const sameDay = end.year === start.year && end.month === start.month && end.day === start.day;
      result += sameDay ? ` \u2013 ${clock(end)}` : "";
    }
  }
  return result;
}

/** Python date.today() in the server's zone is not stable on Vercel; callers pass `today`. */
export function addDays(iso: string, days: number) {
  const moment = parseIsoDate(iso);
  const value = new Date(Date.UTC(moment.year, moment.month - 1, moment.day + days));
  return value.toISOString().slice(0, 10);
}

export function todayIso(now: Date = new Date()) {
  return now.toISOString().slice(0, 10);
}
