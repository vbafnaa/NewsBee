/**
 * The writing floor: the few rules kept after the filtering rewrite, because they keep the
 * newsletter out of legal trouble and avoid real harm to private people.
 *
 *   1. Allegations stay allegations (presumption of innocence): the writer's kind purposes.
 *   2. No names of minors who are suspects, defendants or victims.
 *   3. No names of sexual-assault or domestic-violence victims.
 *   4. No house numbers of private people: incidents are placed at the block.
 *   5. Nothing beyond the sources: the writer's fact checks.
 *   6. Suicide: no method details, and the 988 line is added.
 *
 * Where it can, the floor rewrites rather than holds: names are withheld from the writer's
 * details, and a draft that still breaks a rule after its retry is held for an editor with
 * the rule named.
 */
import { extractAddresses } from "../connectors/locality";
import { rulesOff } from "../core/run-options";
import { MINOR } from "./policy";

const CRIME = /\b(arrest\w*|charged|accused|suspect\w*|defendant|police|shooting|stabb\w*|assault\w*|robbery|burglar\w*|theft|crash|collision|killed|died|death|victim\w*|court|sentenced|convicted|investigation|missing)\b/i;
const MINOR_WORDS = /\b(juvenile|minor|teen(?:ager)?s?|\d{1,2}-year-old (?:boy|girl|student)|(?:boy|girl),? 1[0-7]|student,? 1[0-7]|high school(?:er| student)s?|middle school(?:er| student)s?|child(?:ren)?|kids?)\b/i;
const SEXUAL_OR_DOMESTIC = /\b(sexual(?:ly)? (?:assault\w*|abuse\w*|misconduct|exploitation)|rape\w*|molest\w*|incest|sex offen[cs]e|domestic violence|domestic assault|child (?:abuse|exploitation|pornography)|indecent)\b/i;
const SUICIDE = /\b(suicide|took (?:his|her|their) own life|died by suicide)\b/i;
const SUICIDE_METHOD = /\b(hang(?:ed|ing)|overdos\w*|gunshot|jump(?:ed|ing) from|poison\w*|asphyxia\w*)\b/i;
export const CRISIS_LINE = "If you or someone you know is struggling, call or text 988 to reach the Suicide and Crisis Lifeline.";

export type FloorFlags = { withholdNames: boolean; reason: string | null; blockAddresses: boolean; suicide: boolean };

const SAFETY_KINDS = new Set(["safety_incident", "court_case"]);

/** Home sale and permit records print their address; the house-number rule is about incidents. */
const ADDRESS_KINDS = new Set(["home_sale", "building_permit"]);

/** With `strict`, the flags as if every rule were on, whatever the run's profile. */
export function floorFlags(story: { title: string; description?: string | null; kind?: string }, strict = false): FloorFlags {
  const text = `${story.title} ${story.description ?? ""}`;
  const minorInCrime = (MINOR.test(text) || MINOR_WORDS.test(text)) && CRIME.test(text);
  const victim = SEXUAL_OR_DOMESTIC.test(text);
  return {
    // Names of minors and victims and suicide method stay removed in every run.
    withholdNames: minorInCrime || victim,
    reason: minorInCrime ? "a minor in a crime or incident" : victim ? "a sexual or domestic violence case" : null,
    blockAddresses: !ADDRESS_KINDS.has(story.kind ?? "") && (SAFETY_KINDS.has(story.kind ?? "") || CRIME.test(text)) && (strict || !rulesOff("sensitive")),
    suicide: SUICIDE.test(text),
  };
}

/** Removes withheld names and suicide-method sentences from a draft, so an exploration story can still run. */
export function stripFloorDetails(draft: { headline: string; summary: string }, flags: FloorFlags, people: string[]) {
  let { headline, summary } = draft;
  if (flags.withholdNames) {
    const names = capitalisedNames(people);
    for (const name of [...names, ...names.map((value) => value.split(/\s+/).at(-1)!).filter((surname) => surname.length > 2)]) {
      const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      headline = headline.replace(pattern, "A person");
      summary = summary.replace(pattern, "a person");
    }
  }
  if (flags.suicide) summary = summary.split(/(?<=[.!?])\s+/).filter((sentence) => !SUICIDE_METHOD.test(sentence)).join(" ");
  return { headline, summary };
}

/** Writer instructions for the flags that apply. */
export function floorInstructions(flags: FloorFlags) {
  const rules: string[] = [];
  if (flags.withholdNames) rules.push(`This story involves ${flags.reason}: do not name any person involved (victims, suspects, defendants or family); describe them generally, such as "a teenager" or "a woman".`);
  if (flags.blockAddresses) rules.push("Never give a house or apartment number: place the incident at the block, such as \"the 2400 block of NW 85th St\".");
  if (flags.suicide) rules.push("Do not describe how anyone died.");
  return rules.join(" ");
}

function capitalisedNames(names: string[]) {
  return names.map((value) => value.split(",")[0].trim()).filter((name) => /^[A-Z][a-z'-]+(?:\s+[A-Z][a-z'.-]+)+$/.test(name));
}

/** Floor errors in a draft, given the flags and the people named in the details. */
export function floorErrors(draft: { headline: string; summary: string }, flags: FloorFlags, people: string[]) {
  const text = `${draft.headline} ${draft.summary}`;
  const errors: string[] = [];
  if (flags.withholdNames) {
    const names = capitalisedNames(people);
    const surnames = names.map((name) => name.split(/\s+/).at(-1)!).filter((surname) => surname.length > 2);
    if (names.some((name) => text.includes(name)) || surnames.some((surname) => new RegExp(`\\b${surname}\\b`).test(text))) errors.push("floor:names_withheld");
  }
  if (flags.blockAddresses && extractAddresses(text).some((address) => /^\d{1,6}(?!\d)/.test(address) && !/^\d+00\b/.test(address))) errors.push("floor:house_number");
  if (flags.suicide && SUICIDE_METHOD.test(text)) errors.push("floor:suicide_method");
  return errors;
}

export function explainFloor(errors: string[]) {
  const parts: string[] = [];
  if (errors.includes("floor:names_withheld")) parts.push("Remove every name of the people involved; describe them generally.");
  if (errors.includes("floor:house_number")) parts.push("Replace any house number with the block (for example 'the 2400 block of').");
  if (errors.includes("floor:suicide_method")) parts.push("Remove any description of how the person died.");
  return parts.join(" ");
}
