/**
 * Readability checks for generated articles: sentence length, generic filler, headlines that
 * copy a calendar listing, and event logistics repeated in the prose. These shape how a
 * story reads; the factual checks in story-writer.ts and grounding.ts decide what it may say.
 * Each check is narrow so that a failed draft gets a clear rewrite instruction, not a hold
 * for vague style reasons.
 */
import { proseSentences } from "./news-blurb";

/** Only true run-ons are rejected; ordinary long newspaper sentences are fine. */
export const SENTENCE_WORDS_MAX = 45;

/** Kinds whose date, time and place are shown in the separate When and Where line. */
const LISTING_KINDS = new Set(["event", "meeting_preview"]);

/** Generic lines that add no fact. Allowed only when the source itself uses the phrase. */
const FILLER = [
  "brings new life", "breathe new life", "meaningful way", "great opportunity", "perfect opportunity", "wonderful opportunity",
  "come together", "comes together", "something for everyone", "fun for the whole family", "fun for all ages",
  "a must", "sure to", "make informed decisions", "get the lowdown", "learn how to navigate", "rich tapestry",
  "vibrant community", "hidden gem", "exciting times", "stay tuned", "be sure to", "mark your calendar", "mark your calendars",
  "in the heart of", "it's no secret", "look no further", "the perfect way",
  "not to be missed", "opportunity you won't want to miss", "you won't want to miss", "hauntingly delightful", "a can't-miss",
];
const FILLER_PATTERN = new RegExp(`\\b(?:${FILLER.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]")).join("|")})\\b`, "gi");

const CLOCK_TIME = /\b\d{1,2}(?::\d{2})?\s*(?:[-–]\s*\d{1,2}(?::\d{2})?\s*)?(?:a\.?m\.?|p\.?m\.?)(?![a-z])/i;
const CALENDAR_WORD = /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|June|July|August|September|October|November|December)\b/;
const PHONE = /(?:\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.]\d{4}\b/;
const POSTAL = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;
const STREET_ADDRESS = /\b\d{2,6}\s+(?:[NSEW]{1,2}\s+)?(?:\d{1,3}(?:st|nd|rd|th)|[A-Z][a-z]+)(?:\s+[A-Z][a-z]+)?\s+(?:Ave|Avenue|St|Street|Way|Blvd|Boulevard|Rd|Road|Dr|Drive|Pl|Place|Ln|Lane|Ct|Court|Pkwy|Parkway)\b\.?/;

const STOP = new Set("the a an and or of to for in on at by with from is are was were will be been this that its their it as per has have had which who than then there these those also into about after before over under".split(" "));
const stemWord = (word: string) => { const w = word.toLowerCase().replace(/['’]/g, ""); for (const suffix of ["ing", "ed", "es", "s"]) if (w.length > 5 && w.endsWith(suffix)) return w.slice(0, -suffix.length); return w; };
const contentWords = (text: string) => (text.match(/[A-Za-z0-9$][\w$,'’-]*/g) ?? []).filter((word) => word.length > 2 && !STOP.has(word.toLowerCase())).map(stemWord);
/** Sentences that mostly repeat what earlier sentences already said ("The location is the 2700 block…"). */
export function restatedSentences(summary: string) {
  const seen = new Set<string>();
  return proseSentences(summary).filter((sentence, index) => {
    const content = contentWords(sentence);
    const fresh = content.filter((word) => !seen.has(word)).length;
    content.forEach((word) => seen.add(word));
    return index > 0 && content.length >= 3 && fresh / content.length < 0.3;
  });
}
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const normal = (text: string) => text.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

export type ReadabilityStory = { title: string; description?: string | null; kind?: string };

export function readabilityErrors(story: ReadabilityStory, draft: { headline: string; summary: string }): string[] {
  const errors: string[] = [];
  const source = normal(`${story.title} ${story.description ?? ""}`);
  const listing = LISTING_KINDS.has(story.kind ?? "event");

  // Headline: a newspaper headline, not the calendar entry it came from.
  const headline = draft.headline.trim();
  if (/^(?:join|please join|come|don['’]t miss|discover)\b/i.test(headline)) errors.push("headline:listing_headline:invitation");
  if (CLOCK_TIME.test(headline)) errors.push("headline:listing_headline:clock_time");
  if (listing && CALENDAR_WORD.test(headline)) errors.push("headline:listing_headline:calendar_date");
  // A headline that starts with the whole listing title, date and all, copies the calendar entry.
  if (normal(headline).startsWith(normal(story.title)) && (CLOCK_TIME.test(story.title) || CALENDAR_WORD.test(story.title) || /\bjoin\b|\bvia zoom\b/i.test(story.title))) errors.push("headline:listing_headline:copied_title");
  for (const [phrase] of headline.matchAll(FILLER_PATTERN)) {
    if (!source.includes(normal(phrase))) errors.push(`headline:filler_phrase:${normal(phrase)}`);
  }

  // Summary: readable sentences, no filler, logistics left to the When and Where line.
  const sentences = proseSentences(draft.summary);
  if (sentences.some((sentence) => words(sentence) > SENTENCE_WORDS_MAX)) errors.push("summary:long_sentence");
  for (const [phrase] of draft.summary.matchAll(FILLER_PATTERN)) {
    if (!source.includes(normal(phrase))) errors.push(`summary:filler_phrase:${normal(phrase)}`);
  }
  if (restatedSentences(draft.summary).length) errors.push("summary:restated_fact");
  if (listing && (PHONE.test(draft.summary) || POSTAL.test(draft.summary) || STREET_ADDRESS.test(draft.summary))) errors.push("summary:logistics_in_prose");
  return [...new Set(errors)];
}

/** Rewrite guidance for the retry prompt. */
export function explainReadability(errors: string[]) {
  const notes: string[] = [];
  if (errors.some((error) => error.includes("listing_headline"))) notes.push("Write a newspaper headline that says what is happening, not the calendar entry: no 'Join us', no clock times, and for events no day or date (the When and Where line shows those). Keep the event's own name.");
  if (errors.includes("summary:long_sentence")) notes.push(`Break up run-on sentences longer than ${SENTENCE_WORDS_MAX} words at a natural point; do not chop the story into short disconnected statements.`);
  if (errors.includes("summary:restated_fact")) notes.push("Some sentences only repeat facts already given (the place, the date, the agency, the source). Delete them, and fold any genuinely new detail into the sentence it belongs with, so every sentence moves the story forward.");
  if (errors.some((error) => error.includes("filler_phrase:"))) notes.push("Remove generic filler lines; replace them with a concrete source detail or end the article sooner.");
  if (errors.includes("summary:logistics_in_prose")) notes.push("Leave street addresses, postal codes and phone numbers out of the prose: the When and Where line and source link carry them.");
  return notes.join(" ");
}

/** Errors that an exact-source brief (the source's own words and title) cannot be held for. */
export function isReadabilityError(error: string) {
  return /^(?:headline:(?:listing_headline|filler_phrase)|summary:(?:long_sentence|filler_phrase|logistics_in_prose|restated_fact))/.test(error);
}
