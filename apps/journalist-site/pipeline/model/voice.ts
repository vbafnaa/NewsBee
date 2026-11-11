import { quantities } from "./quantities";
/**
 * The newsletter's voice. Stories are written to be enjoyed and shared, not just filed:
 * hooks, vivid verbs, warmth and good-natured wit, with the facts still locked to the
 * source by the writer's existing checks plus the ones here (no new numbers, superlatives
 * or clickbait). Serious subjects (court cases, deaths, safety and hazards) are always
 * written plainly, whatever the voice setting.
 *
 * NEWSBEE_VOICE: "plain" (the previous neutral style), "lively" (default) or "bold".
 */
import { WORD } from "./news-blurb";

export type Voice = "plain" | "lively" | "bold";
export const VOICES: readonly Voice[] = ["plain", "lively", "bold"];
export const SERIOUS_KINDS = new Set(["court_case", "safety_incident", "obituary", "safety_notice", "weather_alert", "earthquake"]);

export function configuredVoice(value = process.env.NEWSBEE_VOICE): Voice {
  return VOICES.find((voice) => voice === value?.trim().toLowerCase()) ?? "lively";
}
/** The voice actually used for a story kind: serious subjects are always plain. */
export function voiceFor(kind: string | undefined, voice: Voice = configuredVoice()): Voice | "serious" {
  return SERIOUS_KINDS.has(kind ?? "event") ? "serious" : voice;
}

const NEVER = "Never exaggerate, invent stakes, tease something the story does not deliver, use clickbait phrases (such as 'you won't believe', 'shocking', 'jaw-dropping', 'what happens next'), write in all capitals, or add numbers, rankings or superlatives the source does not state.";
const GUIDES: Record<Voice | "serious", string> = {
  plain: "Use a clear, neutral, friendly tone.",
  lively: `Use warm, readable reported prose with concrete details and varied sentence lengths. Lead with the most useful source-supported development. Keep the headline specific and complete. End with a practical next step only when the source states one; otherwise stop when the facts are told. Do not add invitations, emotional benefits, promotional adjectives or a reason to attend. ${NEVER}`,
  bold: `Use concise, energetic reported prose. Lead with the strongest source-supported fact and use direct active verbs. Keep the headline specific. Do not manufacture drama, stakes, motives, community benefits or a closing call to action. ${NEVER}`,
  serious: "This subject is serious. Keep the tone calm, respectful and plain: no jokes, puns, wordplay, exclamation marks, rhetorical questions or dramatic framing.",
};
export function voiceGuide(kind: string | undefined, voice: Voice = configuredVoice()) {
  return GUIDES[voiceFor(kind, voice)];
}
/** Guidance for the edition front page and email, which mix many kinds of stories. */
export function editionVoiceGuide(voice: Voice = configuredVoice()) {
  if (voice === "plain") return GUIDES.plain;
  return `${voice === "bold" ? "Be bold and playful" : "Be warm, lively and witty"}: write it so neighbours want to read on and pass it along. If the top story is about a court case, a death, a safety notice or a hazard, keep the headline and intro respectful and plain. ${NEVER}`;
}

const CLICKBAIT = /\b(you won['’]?t believe|shock(?:ing|ed|er)|jaw[- ]?dropping|mind[- ]?blowing|blow your mind|insane|unbelievable|what happens next|this one trick|outrage(?:ous)?|slams|destroys|epic fail|must[- ]see|breaking)\b/gi;
const SUPERLATIVE = /\b(biggest|largest|best|worst|first[- ]ever|record[- ]breaking|record(?= (?:high|low|number|attendance|turnout|crowd|sales|profit|loss))|unprecedented|historic)\b/gi;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

function sourceText(allowed: string[]) { return allowed.join(" ").toLowerCase(); }
function numbersIn(text: string) { return new Set(quantities(text).map(quantity => quantity.value)); }

/** Voice-specific checks on top of the writer's factual checks. */
export function voiceErrors(value: string, allowed: string[], kind: string | undefined, part: "headline" | "summary" | "intro" | "blurb", voice: Voice = configuredVoice()) {
  const errors: string[] = [];
  if (voice === "plain" && voiceFor(kind, voice) !== "serious") return errors;
  const source = sourceText(allowed);
  for (const match of value.matchAll(CLICKBAIT)) if (!source.includes(match[0].toLowerCase())) errors.push(`clickbait:${match[0].toLowerCase()}`);
  for (const match of value.matchAll(SUPERLATIVE)) if (!new RegExp(`\\b${match[0].toLowerCase()}\\b`).test(source)) errors.push(`unsupported_superlative:${match[0].toLowerCase()}`);
  const known = numbersIn(allowed.join(" "));
  for (const number of numbersIn(value)) if (!known.has(number)) errors.push(`unsupported_number:${number}`);
  const sourceWords = new Set(allowed.flatMap((item) => item.match(WORD) ?? []));
  if ((value.match(WORD) ?? []).some((word) => word.length >= 4 && word === word.toUpperCase() && /[A-Z]/.test(word) && !sourceWords.has(word))) errors.push("shouting");
  const exclamations = (value.match(/!/g) ?? []).length;
  if (voiceFor(kind, voice) === "serious" && (exclamations || /\?\s*$/.test(value) && part === "headline")) errors.push("tone_not_respectful");
  else if (exclamations > (part === "headline" ? 1 : 2)) errors.push("too_many_exclamations");
  return [...new Set(errors)];
}

export function explainVoice(errors: string[]) {
  const notes: string[] = [];
  if (errors.some((error) => /clickbait|shouting|exclamations/.test(error))) notes.push("Keep the energy but drop clickbait phrases, capitals and extra exclamation marks; let a concrete fact do the work.");
  if (errors.some((error) => /unsupported_(?:number|superlative)/.test(error))) notes.push("Use only numbers and superlatives that appear in the story, written the same way.");
  if (errors.some((error) => error.endsWith("tone_not_respectful"))) notes.push("This is a serious subject: no exclamation marks, rhetorical questions or jokes.");
  return notes.join(" ");
}
