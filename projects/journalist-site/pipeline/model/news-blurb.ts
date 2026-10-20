/** Rule-based factuality checks for model-written newsletter text. */
export const WORD = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;
export const LINK = /https?:\/\/|www\.|@|#|\.(?:com|org|net)\b/i;
const SENTENCE_END = /[.!?]+(?=\s|$)/g;
const ABBREVIATION_END = /(?:\b(?:u\.s|e\.g|i\.e|a\.m|p\.m|dr|mr|mrs|ms|st|jr|sr|vs|prof|etc|inc|ltd|dept|approx|no|fig)\.|(?:\b[A-Za-z]\.){1,4})$/i;
export const CLAIM_WORDS = new Set(`free cost costs price prices priced fee fees ticket tickets paid pay donation donations admission register registration registered rsvp signup required require requires limited seats capacity sold waitlist wheelchair asl captioned interpreter cancel canceled cancelled postponed rescheduled online virtual zoom livestream hybrid prize prizes giveaway giveaways raffle award winning noon midnight morning afternoon evening night tonight today tomorrow yesterday am pm minute minutes hour hours`.split(/\s+/));
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
  for (const token of value.match(WORD) ?? []) {
    const lower = token.toLowerCase();
    if (CLAIM_WORDS.has(lower) && !vocabulary.has(lower)) errors.push(`unsupported_claim_word:${lower}`);
  }
  return [...new Set(errors)];
}
