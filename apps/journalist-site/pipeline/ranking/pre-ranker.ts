/**
 * The local pre-ranker: a free, in-pipeline rating with written-down rules, on the same scale as the
 * model's rating (civic, appeal and special, each 0-3, scored civic×3 + appeal×2 + special×1, 0-18),
 * so the two can be compared story by story and either can stand in for the other.
 *
 * It runs on every rated section in shadow: its rating is saved on each item (`pre_rank`) and its
 * agreement with the model goes into the section's ranking report. It replaces the model's rating
 * only where the model gave none: a failed or truncated reply, or a call refused because the run's
 * model budget or Gemini's run or daily limit ran out. A provider rate limit (429) still waits and
 * retries, as before.
 *
 * The rules, each worth one point unless it says otherwise, and each named in `rules` when it applies:
 *
 *   civic    the story kind's civic value (meetings 3, weather alerts 3, court and safety 2, else 0);
 *            +1 it is about government, money, safety or services (CIVIC_WORDS);
 *            +1 it comes from an official source.
 *   appeal   +1 it names the place itself (tier `local`);
 *            +1 two or more independent publishers reported it, +1 more for three or more;
 *            +1 it is something many residents would care about (BROAD_WORDS);
 *            +1 editors accepted at least 70% of this source's stories (5 or more reviewed),
 *            -1 when they accepted 30% or fewer.
 *   special  +1 a one-off (one scheduled date);
 *            +1 time-sensitive: an event in the next 7 days, or news from the last 2 days;
 *            +1 a first, an opening or closing, a deadline, a record, or an update to a printed story;
 *            routine (3 or more scheduled dates) scores 0.
 *
 * Each dimension is clamped to 0-3. Reader signals are applied afterwards by the v5 ranker, to the
 * pre-ranker's rating exactly as to the model's.
 */
import { kindDefinition, NEWS_KINDS } from "../editorial/kinds";
import { score, type Category, type Rating } from "../model/newsworthiness";

export const PRE_RANK_POLICY = "pre_ranker_v1";

export const CIVIC_WORDS = /\b(council|commission(ers)?|board|hearing|vote[ds]?|ballot|levy|bond|election|budget|tax(es)?|fee|permit|zoning|ordinance|road|street|closure|closed|closing|detour|construction|water|sewer|boil|outage|evacuat\w*|emergency|fire|police|sheriff|arrest\w*|court|school district|public meeting|deadline|apply|application|assistance)\b/i;
export const BROAD_WORDS = /\b(festival|parade|fair|market|concert|free|famil(y|ies)|community|celebrat\w*|holiday|veterans?|grand opening|championship|playoffs?|state|fireworks|rodeo|roundup|library|park|lake)\b/i;
export const SPECIAL_WORDS = /\b(first|new|opens?|opening|closes?|closing|final|last chance|deadline|record|historic|annual|anniversary|retire\w*|honou?r\w*|award\w*)\b/i;

export type SourceRate = { accepted: number; rejected: number };
export type PreRankInput = {
  id: string; title: string; description?: string | null; kind?: string; tier?: string; source_tier?: string | null;
  section?: string | null; first_date: string; occurrences: number; independent?: number | null; update_of?: unknown; source_id?: string | null;
};
export type PreRank = { rating: Rating; score: number; rules: string[]; policy: string };

const SECTION_CATEGORY: Record<string, Category> = {
  civic: "government_and_policy", safety: "public_safety_and_hazards", weather: "public_safety_and_hazards",
  schools: "kids_and_family", sports: "kids_and_family", real_estate: "civic_and_practical", business: "civic_and_practical",
};
const clamp = (value: number) => Math.max(0, Math.min(3, value));
const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000;

/** What editors thought of a source's stories, once enough are reviewed to mean something. */
export function editorSignal(rate: SourceRate | undefined): -1 | 0 | 1 {
  const total = (rate?.accepted ?? 0) + (rate?.rejected ?? 0);
  if (!rate || total < 5) return 0;
  const share = rate.accepted / total;
  return share >= 0.7 ? 1 : share <= 0.3 ? -1 : 0;
}

export function preRate(input: PreRankInput, context: { today: string; sourceRates?: Map<string, SourceRate> }): PreRank {
  const rules: string[] = [];
  const kind = input.kind ?? "event";
  const text = `${input.title} ${input.description ?? ""}`;

  const base = kindDefinition(kind).civic ?? 0;
  let civic = base;
  if (base) rules.push(`civic ${base}: ${kind.replace(/_/g, " ")}`);
  if (CIVIC_WORDS.test(text)) { civic += 1; rules.push("civic +1: government, money, safety or services"); }
  if (input.source_tier === "official") { civic += 1; rules.push("civic +1: official source"); }

  let appeal = 0;
  if ((input.tier ?? "local") === "local") { appeal += 1; rules.push("appeal +1: names the place"); }
  const independent = Math.max(1, Number(input.independent ?? 1));
  if (independent >= 2) { appeal += 1; rules.push(`appeal +1: ${independent} independent publishers`); }
  if (independent >= 3) { appeal += 1; rules.push("appeal +1: three or more publishers"); }
  if (BROAD_WORDS.test(text)) { appeal += 1; rules.push("appeal +1: broad local interest"); }
  const signal = editorSignal(input.source_id ? context.sourceRates?.get(input.source_id) : undefined);
  if (signal) { appeal += signal; rules.push(signal > 0 ? "appeal +1: editors accept this source's stories" : "appeal -1: editors reject this source's stories"); }

  let special = 0;
  if (input.occurrences >= 3) rules.push("special 0: routine, 3 or more dates");
  else {
    if (input.occurrences <= 1) { special += 1; rules.push("special +1: one-off"); }
    const ahead = days(context.today, input.first_date);
    const news = NEWS_KINDS.has(kind);
    if (news ? ahead <= 0 && ahead >= -2 : ahead >= 0 && ahead <= 7) { special += 1; rules.push(news ? "special +1: news from the last 2 days" : "special +1: in the next 7 days"); }
    if (input.update_of || SPECIAL_WORDS.test(text)) { special += 1; rules.push(input.update_of ? "special +1: update to a printed story" : "special +1: a first, opening, closing, deadline or record"); }
  }

  const rating: Rating = { id: input.id, category: SECTION_CATEGORY[input.section ?? ""] ?? "other", civic: clamp(civic), appeal: clamp(appeal), special: clamp(special) };
  return { rating, score: score(rating), rules, policy: PRE_RANK_POLICY };
}

/** Spearman's rank correlation between two score lists over the same stories, or null under 3. */
export function rankAgreement(left: number[], right: number[]) {
  if (left.length !== right.length || left.length < 3) return null;
  const ranks = (values: number[]) => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
    const out = new Array<number>(values.length);
    for (let start = 0; start < order.length;) {
      let end = start;
      while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
      for (let position = start; position <= end; position += 1) out[order[position].index] = (start + end) / 2 + 1;
      start = end + 1;
    }
    return out;
  };
  const a = ranks(left), b = ranks(right);
  const mean = (a.length + 1) / 2;
  let numerator = 0, leftSum = 0, rightSum = 0;
  for (let index = 0; index < a.length; index += 1) { numerator += (a[index] - mean) * (b[index] - mean); leftSum += (a[index] - mean) ** 2; rightSum += (b[index] - mean) ** 2; }
  return leftSum && rightSum ? Math.round((numerator / Math.sqrt(leftSum * rightSum)) * 1000) / 1000 : null;
}
