/** Narrow deterministic checks, not a substitute for semantic/editorial review. */
const normal = (text: string) => text.toLowerCase().replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const NEGATED_OR_CONDITIONAL = /\b(?:not|never|no|cannot|can't|hasn't|haven't|hadn't|isn't|wasn't|weren't|wasn’t|hasn’t|isn’t|whether|if|would|could|may|might|will|pending)\b/i;
const ACTIONS = [
  { pattern: /\b(?:approved|adopted|enacted|passed)\b/gi, error: "unsupported_decision" },
  { pattern: /\b(?:completed|opened|began|started)\b/gi, error: "unsupported_completion" },
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


/** Catch newly introduced capitalized names in prose; this is not a full entity linker. */
export function namedEntityErrors(value: string, allowed: string[]) {
  const stem = (word: string) => word.toLowerCase().replace(/[’']s$/, "").replace(/s$/, "");
  const known = new Set(allowed.flatMap((text) => text.match(/[A-Za-z]+(?:[’'][A-Za-z]+)?/g) ?? []).map(stem));
  const grammar = new Set(["a", "an", "the", "this", "that", "these", "those", "it", "its", "no"]);
  const unknown = new Set<string>();
  for (const match of value.matchAll(/\b[A-Z][a-z]+(?:\s+(?:(?:of|the|and|for)\s+)?[A-Z][a-z]+)+\b/g)) {
    for (const word of match[0].match(/[A-Z][a-z]+/g) ?? []) {
      if (!grammar.has(word.toLowerCase()) && !known.has(stem(word))) unknown.add(word);
    }
  }
  for (const match of value.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const before = value.slice(0, match.index).trimEnd();
    // A lone capital at a sentence opening is usually just ordinary grammar.
    if (!before || /[.!?:]["”')]*$/.test(before)) continue;
    if (!known.has(stem(match[0])) && !grammar.has(match[0].toLowerCase())) unknown.add(match[0]);
  }
  return [...unknown].map((name) => `unsupported_name:${name}`);
}
