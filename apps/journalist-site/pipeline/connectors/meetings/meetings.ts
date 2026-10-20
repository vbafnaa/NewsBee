import { plainText, scheduleText, type EventFacts, type LocalMoment } from "../common";
import type { CommunityEvidence } from "../community";

export const MAX_ITEMS = 5;
export const ITEM_MAX = 200;
export const LEAD_MAX = 100;
export const NOTE_MAX = 300;
export const NO_VENUE = "Location listed in the agenda";

const PROCEDURAL_START = /^(call(ed)? to order|roll call|pledge of allegiance|invocation|moment of silence|land acknowledg|(approv|adopt|amend)\w*( of)?( the)?( draft)? (agenda|minutes)|motion to .*\b(agenda|minutes|adjourn)|adjourn|public (comment|forum|input|participation)s?\b)/i;
const PROCEDURAL_ANY = /\bmeeting minutes\b|\bminutes of\b|^minutes\b|\bminutes$/i;
const LEADING_MARKS = /^[^\w("'“‘$]+/;
const PRIVATE = /\((tenant|landlord|appellant|petitioner|respondent|claimant|grievant)\)|security deposit case|effective date of benefit|retirement application|disability retirement|personnel matter|workers'? compensation claim/i;
const PROCEDURAL_WHOLE_FIXED = /^((draft )?agenda|(draft )?minutes|public (comment|forum|input|participation)s?|(verbal|written) comments|communications?|correspondence|consent (agenda|calendar)|(new|old|unfinished|other) business|any other .*business|announcements?|((staff |council |member |council member )?(reports?|comments))|[\w .'&-]* updates?( \(.*\))?|closed session|executive session|recess|information\/upcoming business|[\w .&-]*['’]s reports?|(commissioner|board|member|council|committee|chair)s?( member)?s? items|vote anticipated|opening( \(.*\))?)$/i;
const BOILERPLATE = /reasonable accommodation|sign language|interpret/i;
const LINK = /https?:\/\/\S+|www\.\S+/i;
const CANCELLED = /cancel/i;
const MEETING_SUFFIX = /[\s:-]*\b((regular|special|work session|study session)\s*)?meeting$/i;
const ROLES: Array<[RegExp, string]> = [
  [/appeal|adjustment/i, "hears appeals and requests for exceptions to local rules"],
  [/planning|zoning|land use/i, "reviews land-use, zoning and development proposals"],
  [/school|education/i, "governs the local public schools"],
  [/retirement|pension|budget|finance|audit|\btax/i, "oversees public money and finances"],
  [/\b(city|town|village|common|borough|county) council$|^council$|^board of (aldermen|selectmen|supervisors|county commissioners)$|select ?board|^(village )?board of trustees$|^city commission$/i, "is the elected body that sets local laws, policies and the budget"],
  [/committee/i, "is a committee of the local government that studies specific matters"],
  [/park|recreation/i, "advises on parks and recreation"],
  [/housing/i, "works on local housing programs and policy"],
  [/librar/i, "oversees the public library"],
  [/transport|traffic|transit|mobility|street/i, "advises on streets, traffic and transit"],
  [/environment|sustainab|energy|climate|electric/i, "works on energy and the environment"],
  [/historic|preservation|landmark/i, "reviews changes to historic buildings and districts"],
  [/police|public safety|fire/i, "advises on policing, fire and public safety"],
  [/design|architect/i, "reviews the design of buildings and public spaces"],
  [/\barts?\b|culture/i, "advises on public art and culture"],
];

export type MeetingItem = { title: string; consent?: boolean; weight?: number; outcome?: string | null };
export type Meeting = {
  source_event_id: string; body: string; start: LocalMoment; venue?: string | null; source_url: string;
  items: MeetingItem[]; draft_agenda?: boolean; minutes_final?: boolean; note?: string | null;
  community_relevance?: CommunityEvidence[];
};
export type MeetingFacts = EventFacts & { kind: "meeting_preview" | "meeting_outcome"; body: string; agenda_items: number };

export function bodyName(name: string) {
  const normalized = name.split(/\s+/).filter(Boolean).join(" ");
  return normalized.replace(MEETING_SUFFIX, "").replace(/^[ -:]+|[ -:]+$/g, "") || name.trim();
}
export function cancelled(...values: Array<string | null | undefined>) { return values.some((value) => Boolean(value && CANCELLED.test(value))); }
export function itemTitle(value: string | null | undefined): string | null {
  const text = plainText(value, ITEM_MAX);
  if (!text || (value ?? "").length > 4 * ITEM_MAX || BOILERPLATE.test(text) || PRIVATE.test(value ?? "")) return null;
  const clean = text.replace(LEADING_MARKS, "").replace(/\.+$/, "");
  if (!clean || PROCEDURAL_START.test(clean) || PROCEDURAL_WHOLE_FIXED.test(clean) || PROCEDURAL_ANY.test(clean)) return null;
  return clean;
}
export function select(items: MeetingItem[]): MeetingItem[] {
  const best = new Map<string, { position: number; item: MeetingItem }>();
  items.forEach((item, position) => {
    const key = item.title.toLocaleLowerCase("und");
    const existing = best.get(key);
    if (!existing) best.set(key, { position, item });
    else if ((item.weight ?? 0) > (existing.item.weight ?? 0)) best.set(key, { position: existing.position, item });
  });
  return [...best.values()].sort((a, b) => Number(Boolean(a.item.consent)) - Number(Boolean(b.item.consent)) || (b.item.weight ?? 0) - (a.item.weight ?? 0) || a.position - b.position).map(({ item }) => item);
}
export function context(body: string, place: string) {
  const role = ROLES.find(([pattern]) => pattern.test(body))?.[1] ?? `is a public body of ${place}'s local government`;
  return `${body.toLowerCase().startsWith("the ") ? "" : "The "}${body} ${role}.`;
}
function lead(item: MeetingItem) {
  if (item.title.length <= LEAD_MAX) return item.title;
  return `${item.title.slice(0, LEAD_MAX).replace(/\s+\S*$/, "").replace(/[,;:. ]+$/, "")}...`;
}
function facts(meeting: Meeting, kind: MeetingFacts["kind"], title: string, description: string, count: number): MeetingFacts {
  const date = `${String(meeting.start.year).padStart(4, "0")}-${String(meeting.start.month).padStart(2, "0")}-${String(meeting.start.day).padStart(2, "0")}`;
  return {
    source_event_id: meeting.source_event_id,
    title,
    event_date: date,
    schedule_text: scheduleText(meeting.start),
    venue: (meeting.venue ?? "").replace(/\s+/g, " ").trim().slice(0, ITEM_MAX) || NO_VENUE,
    source_url: meeting.source_url,
    description: plainText(description),
    kind,
    body: meeting.body,
    agenda_items: count,
    ...(meeting.community_relevance ? { community_relevance: meeting.community_relevance } : {}),
  };
}
function withoutLinks(note: string) {
  return note.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter((sentence) => sentence && !LINK.test(sentence)).join(" ");
}
export function preview(meeting: Meeting, place: string): MeetingFacts | null {
  const items = select(meeting.items);
  if (!items.length) return null;
  const shown = items.slice(0, MAX_ITEMS);
  const parts = [context(meeting.body, place), `On the agenda: ${shown.map((item) => item.title).join("; ")}.`];
  if (items.length > shown.length) parts.push(`The full agenda lists ${items.length - shown.length} more items.`);
  if (meeting.draft_agenda) parts.push("The agenda is a draft and may change before the meeting.");
  const note = plainText(withoutLinks(meeting.note ?? ""), NOTE_MAX);
  if (note) parts.push(`Note from the clerk: ${note}`);
  return facts(meeting, "meeting_preview", `${meeting.body} agenda: ${lead(shown[0])}`, parts.join(" "), items.length);
}
export function outcome(meeting: Meeting, place: string): MeetingFacts | null {
  const items = select(meeting.items.filter((item) => item.outcome));
  if (!items.length) return null;
  const shown = items.slice(0, MAX_ITEMS);
  const parts = [context(meeting.body, place), `Recorded outcomes: ${shown.map((item) => `${item.title} (${item.outcome})`).join("; ")}.`];
  if (items.length > shown.length) parts.push(`The meeting record lists ${items.length - shown.length} more outcomes.`);
  parts.push(meeting.minutes_final ? "These results come from the approved minutes." : "These results come from the clerk's meeting record; the official minutes are not yet approved.");
  return facts(meeting, "meeting_outcome", `${meeting.body} decisions: ${lead(shown[0])}`, parts.join(" "), items.length);
}
