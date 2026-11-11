import { quantities } from "./quantities";
/** Rule-based factuality checks for model-written newsletter text. */
export const WORD = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;
export const LINK = /https?:\/\/|www\.|@|#|\.(?:com|org|net)\b/i;
const SENTENCE_END = /[.!?]+(?=\s|$)/g;
const ABBREVIATION_END = /(?:\b(?:u\.s|e\.g|i\.e|a\.m|p\.m|dr|mr|mrs|ms|st|ave|blvd|rd|ln|ct|nw|ne|sw|se|jr|sr|vs|prof|etc|inc|ltd|dept|approx|no|fig)\.|(?:\b[A-Za-z]\.){1,4})$/i;
export const CLAIM_WORDS = new Set(`free cost costs price prices priced fee fees ticket tickets paid pay donation donations admission register registration registered rsvp signup required require requires limited seats capacity sold waitlist wheelchair asl captioned interpreter cancel canceled cancelled postponed rescheduled online virtual zoom livestream hybrid prize prizes giveaway giveaways raffle award winning noon midnight morning afternoon evening night tonight today tomorrow yesterday am pm minute minutes hour hours`.split(/\s+/));
/** Intl can split a person's middle initial from their surname. Keep those
 * abbreviations attached without joining ordinary following sentences. */
export function proseSentences(value: string) {
  const parts = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(value), ({ segment }) => segment.trim()).filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    const previous = result.at(-1);
    if (previous && ABBREVIATION_END.test(previous) && !/^(?:The|This|That|These|Those|He|She|It|They|We|Our|His|Her|In|On|At|After|Before|According)\b/.test(part)) result[result.length - 1] = `${previous} ${part}`;
    else result.push(part);
  }
  return result;
}

export function sentenceCount(value: string) {
  let count = 0;
  for (const match of value.matchAll(SENTENCE_END)) {
    const punctuation = match[0];
    const abbreviation = punctuation.includes(".") ? value.slice(0, (match.index ?? 0) + 1).match(ABBREVIATION_END)?.[0] : undefined;
    const clockEndsSentence = !!abbreviation && /^(?:a|p)\.m\.$/i.test(abbreviation) && /^\s+[A-Z]/.test(value.slice((match.index ?? 0) + punctuation.length));
    if (abbreviation && !clockEndsSentence) continue;
    count += 1;
  }
  return count;
}
export function addedClaims(value: string, allowed: string[], maxSentences: number): string[] {
  const errors: string[] = [];
  if (/[\n\r]/.test(value)) errors.push("multiple_lines");
  if (LINK.test(value)) errors.push("link_or_handle");
  const vocabulary = new Set(allowed.flatMap((item) => item.match(WORD) ?? []).map((word) => word.toLowerCase()));
  let stripped = value;
  for (const item of [...allowed].filter(Boolean).sort((a, b) => b.length - a.length)) stripped = stripped.split(item).join(" ");
  if (sentenceCount(`${stripped.trim()} `) > maxSentences) errors.push("too_many_sentences");
  for (const match of value.matchAll(WORD)) {
    const token = match[0];
    const lower = token.toLowerCase();
    // A compound adjective is not an admission-price assertion.
    const compoundPrefix = value.slice(0, match.index).match(/([A-Za-z]+)[-–—]$/)?.[1];
    if (lower === "free" && compoundPrefix && allowed.some(source => new RegExp(`\\b${compoundPrefix}[-–—]free\\b`, "i").test(source))) continue;
    if (CLAIM_WORDS.has(lower) && (!vocabulary.has(lower) || lower === "free" && !/(?<![A-Za-z-])free\b/i.test(allowed.join(" ")))) errors.push(`unsupported_claim_word:${lower}`);
  }
  errors.push(...factualErrors(value, allowed));
  return [...new Set(errors)];
}

// Factual checks apply to every voice, including plain. Keep polarity and decision
// status tied to a relevant source sentence rather than a bag of source words.
const FACT_STOP = new Set("the a an and or of to for in on at by with from is are was were will would has have had be been it this that its their they not no only can may must should said says".split(" "));
const factWords = (text: string) => new Set((text.toLowerCase().match(WORD) ?? []).filter((word) => word.length > 2 && !FACT_STOP.has(word)));
const factSentences = (text: string) => text.split(/(?<=[.!?])\s+|[\n;]+/).filter(Boolean);
const numbers = (text: string) => quantities(text).map(quantity => quantity.value);
const POLARITIES: Array<{ name: string; positive: RegExp; negative: RegExp; pending?: RegExp }> = [
  { name: "registration", positive: /\b(?:registration|rsvp) (?:is |are )?required\b|\bmust register\b/i, negative: /\b(?:registration|rsvp) (?:is |are )?(?:not required|optional)\b|\bno registration(?: is)? required\b|\bneed not register\b/i },
  { name: "approval", positive: /\b(?:approv(?:e|es|ed|ing)|adopt(?:s|ed|ing)?|enact(?:s|ed|ing)?|authoriz(?:e|es|ed|ing))\b/i, negative: /\b(?:not|never) (?:yet )?(?:approved|adopted|enacted|authorized)\b/i, pending: /\b(?:would|could|may|might|will) (?:be )?(?:approved|adopted|enacted|authorized)\b/i },
  { name: "cancellation", positive: /\b(?:cancelled|canceled)\b/i, negative: /\b(?:not|never) (?:cancelled|canceled)\b/i },
];
export function factualErrors(value: string, allowed: string[]): string[] {
  const errors: string[] = [];
  const original = allowed.join(" ");
  for (const match of value.matchAll(/[“"]([^“”"]{3,})[”"]/g)) {
    if (!original.toLowerCase().replace(/\s+/g, " ").includes(match[1].toLowerCase().replace(/\s+/g, " "))) errors.push("unsupported_quotation");
  }
  const known = new Set(numbers(original));
  for (const number of numbers(value)) if (!known.has(number)) errors.push(`unsupported_number:${number}`);
  const sources = allowed.flatMap(factSentences);
  for (const sentence of factSentences(value)) {
    const keys = factWords(sentence);
    const relevant = sources.filter((source) => [...factWords(source)].some((word) => keys.has(word)));
    for (const rule of POLARITIES) {
      const negated = rule.negative.test(sentence);
      const asserted = rule.positive.test(sentence) && !negated;
      if (!negated && !asserted) continue;
      const matching = relevant.filter((source) => rule.positive.test(source) || rule.negative.test(source) || rule.pending?.test(source));
      // Preserve verbatim source statements before checking paraphrased status.
      if (matching.some((source) => source.toLowerCase().includes(sentence.toLowerCase()))) continue;
      const supported = matching.some((source) => negated ? rule.negative.test(source) : rule.positive.test(source) && !rule.negative.test(source) && !rule.pending?.test(source));
      if (!supported) errors.push(`unsupported_status:${rule.name}`);
    }
  }
  return [...new Set(errors)];
}
