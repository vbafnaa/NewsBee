/** Narrow deterministic checks, not a substitute for semantic/editorial review. */
const normal = (text: string) => text.toLowerCase().replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const NEGATED_OR_CONDITIONAL = /\b(?:not|never|no|cannot|can't|hasn't|haven't|hadn't|isn't|wasn't|weren't|wasn’t|hasn’t|isn’t|whether|if|would|could|may|might|will|pending)\b|\b(?:plans? (?:to|on)|planning to|goals? (?:of|is|are)|aim(?:s|ing)? to|expect(?:s|ed|ing)? to|intend(?:s|ing)? to)\b/i;
const ACTIONS = [
  { pattern: /\b(?:approved|adopted|enacted|passed)\b/gi, error: "unsupported_decision" },
  { pattern: /\b(?:completed|opened|began|started|underway|under way|in progress)\b/gi, error: "unsupported_completion" },
  { pattern: /\b(?:under contract|(?:secured|signed|awarded) (?:a |the )?contract)\b/gi, error: "unsupported_contract_status" },
];
function asserted(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].some((match) => {
    const before = text.slice(0, match.index);
    const clause = before.split(/[.!?;\n]|\bbut\b/i).at(-1) ?? "";
    return !NEGATED_OR_CONDITIONAL.test(clause);
  });
}
export function groundingErrors(value: string, allowed: string[]) {
  const errors: string[] = [];
  const source = allowed.map(normal);
  // Quoted phrases must be present verbatim (apart from case/space/quote typography).
  for (const match of value.matchAll(/["“]([^"“”\n]+)["”]/g)) {
    if (!source.some((text) => text.includes(normal(match[1])))) errors.push("unsupported_quote");
  }
  const purposes = /\b(?:to|for|in order to)\s+(honou?r|celebrate|connect|foster|inspire|boost|strengthen|spark|promote|improve|develop)\b/gi;
  for (const match of value.matchAll(purposes)) {
    const verb = match[1].toLowerCase();
    if (!source.some((text) => new RegExp(`\\b${verb}\\w*\\b`, "i").test(text))) errors.push("unsupported_purpose");
  }
  // "the 2700 block of NE 92nd St" is block-level; "2700 NE 92nd St" claims an exact address.
  for (const [, number, street] of allowed.join(" ").matchAll(/\b(\d{2,6})\s+block\s+of\s+((?:[NSEW]{1,2}\s+)?[\w.]+)/gi)) {
    if (new RegExp(`\\b${number}\\s+(?!block\\b)${street.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(value)) errors.push("unsupported_exact_address");
  }
  // A source range ("another 1-2 volunteers") must not become one exact number ("two volunteers").
  const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const stated = new Set([...value.matchAll(/\b(\d{1,3}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi)].map(([word]) => /\d/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word.toLowerCase())));
  for (const [range, low, high] of allowed.join(" ").matchAll(/\b(\d{1,3})\s*[-–]\s*(\d{1,3})\b(?!\s*(?:[ap]\.?m\b|percent|%))/gi)) {
    const a = Number(low), b = Number(high);
    if (!(a < b && b - a <= 10)) continue;
    const kept = new RegExp(`\\b(?:${a}|${NUMBER_WORDS[a] ?? a})\\s*(?:[-–]|to|or)\\s*(?:${b}|${NUMBER_WORDS[b] ?? b})\\b`, "i").test(value);
    if (!kept && (stated.has(a) || stated.has(b)) && !value.includes(range)) errors.push("unsupported_number_range");
  }
  if (/\bback on (?:track|schedule)\b/i.test(value) && !allowed.some(text => /\bback on (?:track|schedule)\b/i.test(text))) errors.push("unsupported_recovery");
  if (allowed.some(text => /\bno school\b|\bschools? (?:is |are )?closed\b/i.test(text)) && /\b(?:students|pupils) (?:will )?attend classes as usual\b|\bclasses (?:will )?continue as usual\b/i.test(value)) errors.push("unsupported_closure_contradiction");
  for (const action of ACTIONS) {
    if (asserted(value, action.pattern) && !allowed.some((text) => asserted(text, action.pattern))) errors.push(action.error);
  }
  return [...new Set(errors)];
}

/** Reported articles should not turn source listings into advertisements. */
export function reportingErrors(value: string, title: string, headline = false) {
  const errors: string[] = [];
  const promotion = /\b(?:don't miss(?: out)?|do not miss|fun[- ]filled|magical (?:learning |community )?adventure|honou?r our (?:military |brave )?(?:heroes|men|women)|meaningful observance|a chance to connect|something for everyone|(?:visit|find) a (?:library |local )?branch near you)\b/gi;
  if ([...value.matchAll(promotion)].some(([phrase]) => !headline || !normal(title).includes(normal(phrase)))) errors.push("promotional_language");
  if (!headline && /(?:^|[.!?]\s+)(?:join\b|celebrate\b|don't miss|discover the magic)/i.test(value)) errors.push("promotional_language");
  if (!headline && /^\s*drop in\b/i.test(value)) errors.push("promotional_language");
  return [...new Set(errors)];
}

/** Exploration may relax selection/style, but must not approve invented facts. */
export function hasFactualityError(errors: string[]) {
  return errors.some((error) => /(?:^|:)(?:unsupported_|attention_statistic_not_news)/.test(error));
}


/** True when two lower-case words differ by at most one inserted, deleted or changed letter. */
function withinOneEdit(a: string, b: string) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
/** Catch newly introduced capitalized names in prose; this is not a full entity linker. */
export function namedEntityErrors(value: string, allowed: string[]) {
  const stem = (word: string) => word.toLowerCase().replace(/[’']s$/, "").replace(/s$/, "");
  const known = new Set(allowed.flatMap((text) => text.match(/[A-Za-z]+(?:[’'][A-Za-z]+)?/g) ?? []).map(stem));
  // Street-type abbreviations in records ("NE 92ND ST") cover the spelled-out word in prose.
  const ABBREVIATIONS: Record<string, string> = { st: "street", ave: "avenue", av: "avenue", rd: "road", blvd: "boulevard", dr: "drive", ln: "lane", ct: "court", pl: "place", pkwy: "parkway", hwy: "highway", n: "north", s: "south", e: "east", w: "west" };
  for (const word of [...known]) if (ABBREVIATIONS[word]) known.add(stem(ABBREVIATIONS[word]));
  const grammar = new Set(["a", "an", "the", "this", "that", "these", "those", "it", "its", "no"]);
  // Ordinary words that open a sentence before a real name ("Every Tuesday", "On Wednesday").
  const openers = new Set("every each on in at from for with during after before since join all some many most both families residents neighbors neighbours kids children parents attendees visitors volunteers according starting beginning until".split(" "));
  // A source typo ("Communit Council") must not make the correct spelling look invented.
  const nearKnown = (word: string) => word.length >= 7 && [...known].some((other) => other.length >= 6 && Math.abs(other.length - word.length) <= 1 && withinOneEdit(other, stem(word)));
  const isKnown = (word: string) => known.has(stem(word)) || nearKnown(word);
  const unknown = new Set<string>();
  for (const match of value.matchAll(/\b[A-Z][a-z]+(?:\s+(?:(?:of|the|and|for)\s+)?[A-Z][a-z]+)+\b/g)) {
    const before = value.slice(0, match.index).trimEnd();
    const opensSentence = !before || /[.!?:]["”')]*$/.test(before);
    (match[0].match(/[A-Z][a-z]+/g) ?? []).forEach((word, index) => {
      if (index === 0 && opensSentence && openers.has(word.toLowerCase())) return;
      if (!grammar.has(word.toLowerCase()) && !isKnown(word)) unknown.add(word);
    });
  }
  for (const match of value.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const before = value.slice(0, match.index).trimEnd();
    // A lone capital at a sentence opening is usually just ordinary grammar.
    if (!before || /[.!?:]["”')]*$/.test(before)) continue;
    if (!isKnown(match[0]) && !grammar.has(match[0].toLowerCase())) unknown.add(match[0]);
  }
  return [...unknown].map((name) => `unsupported_name:${name}`);
}

/** Event notices also arrive as local_news. Inspect explicit event statements,
 * not unrelated publication dates, deadlines or historical mentions. */
export function sourceDateConflict(title: string, description: string) {
  const parse = (text: string) => [...text.matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s*(?:\*\*)?(\d{1,2})(?:st|nd|rd|th)?\b/gi)]
    .map(match => `${match[1].slice(0, 3).toLowerCase()}-${Number(match[2])}`);
  if (!/\b(?:meeting|event|session|workshop|gathering|forum)\b/i.test(title)) return false;
  const titleDates = parse(title);
  if (titleDates.length !== 1) return false;
  return Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(description.slice(0, 2000)), ({ segment }) => segment).some(sentence => {
    if (!/\b(?:meeting|event|session|workshop|gathering|forum)\b.{0,100}\b(?:on|scheduled for|set for|takes place(?: on)?|will take place(?: on)?|is(?: on)?)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*,?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(sentence)) return false;
    const dates = parse(sentence);
    return dates.length === 1 && dates[0] !== titleDates[0] && !/\b(?:previous|last|earlier|rescheduled from|moved from|formerly|cancelled|canceled)\b/i.test(sentence);
  });
}
