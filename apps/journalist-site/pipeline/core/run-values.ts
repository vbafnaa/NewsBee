/**
 * Run option names and defaults, with no server imports, so the kick-off panel and the
 * pipeline read the same lists.
 */
/**
 * Paid services and each one's default budget a run. NEWSBEE_PAID_BUDGETS overrides them. Exa and
 * Tavily get 60 and the agent's model 100 so an exhaustive source run gets its even share per
 * category (60 / 10 categories = 6); Dorking stays at 20 (2 a category). The gateway still stops a
 * service at the lower of this and its hard limit a run.
 */
export const PAID_SERVICES = [
  { id: "model", label: "Model calls", use: "Writing, ranking, extraction, discovery and the model check, on your configured models in order", budget: 800 },
  { id: "tavily", label: "Tavily", use: "Council documents, agent search and site exploration", budget: 60 },
  { id: "serpapi", label: "SerpApi", use: "Google operator search", budget: 20 },
  { id: "searchapi", label: "SearchApi", use: "Google operator search", budget: 20 },
  { id: "brightdata", label: "Bright Data", use: "Google operator search", budget: 20 },
  { id: "brightdata_open", label: "Bright Data page opening", use: "Paid fallback for opening pages (Web Unlocker)", budget: 20 },
  { id: "exa", label: "Exa", use: "Meaning-based agent search", budget: 60 },
  { id: "scrapingbee", label: "ScrapingBee", use: "JavaScript-rendered pages (not in agent runs)", budget: 20 },
  { id: "jev", label: "Jev (TypeSafe)", use: "Result, page and item classification", budget: 20 },
  { id: "agent_model", label: "Agent model", use: "Agent planning and extraction on a hosted model", budget: 100 },
  { id: "attom", label: "ATTOM", use: "Home sale prices, if county records are thin", budget: 20 },
] as const;
export type PaidService = typeof PAID_SERVICES[number]["id"];
export const PAID_SERVICE_IDS = PAID_SERVICES.map((service) => service.id) as readonly PaidService[];
/** Budgets from before one model budget: a run that ticked either has a model budget of the larger. */
export const LEGACY_MODEL_SERVICES = ["gemini", "openai_compatible"] as const;

/**
 * A run's budget for a paid service. A run saved before one model budget still has its Gemini and
 * OpenAI-compatible budgets, so its model budget is the larger of them.
 */
export function paidAllowance(paid: Partial<Record<string, number>> | undefined, service: string): number | undefined {
  const value = paid?.[service];
  if (value !== undefined || service !== "model") return value;
  const legacy = LEGACY_MODEL_SERVICES.map((id) => paid?.[id]).filter((budget): budget is number => budget !== undefined);
  return legacy.length ? Math.max(...legacy) : undefined;
}

export const FREE_SERVICES = [
  { id: "gdelt", label: "GDELT", hosts: ["gdeltproject.org"] },
  { id: "overpass", label: "Overpass (OpenStreetMap)", hosts: ["overpass-api.de", "overpass.kumi.systems", "overpass.private.coffee", "maps.mail.ru"] },
  { id: "nominatim", label: "Nominatim (OpenStreetMap)", hosts: ["nominatim.openstreetmap.org"] },
  { id: "socrata", label: "Socrata", hosts: ["api.us.socrata.com"] },
  { id: "nws", label: "National Weather Service", hosts: ["api.weather.gov"] },
  { id: "wikidata", label: "Wikidata", hosts: ["wikidata.org", "query.wikidata.org"] },
  { id: "wikimedia", label: "Wikimedia Commons photos", hosts: ["wikimedia.org"] },
  { id: "bluesky", label: "Bluesky", hosts: ["api.bsky.app"] },
  { id: "jina", label: "Jina Reader", hosts: ["r.jina.ai"] },
  { id: "county_records", label: "County assessor and recorder data", hosts: [] },
  { id: "nces", label: "NCES school district directory", hosts: ["nces.ed.gov"] },
] as const;
export type FreeService = typeof FREE_SERVICES[number]["id"];

export const GUARDRAIL_GROUPS = ["caps", "quality", "sensitive", "topic_content"] as const;
export type GuardrailGroup = typeof GUARDRAIL_GROUPS[number];
/**
 * What the Access setting switches: Respect follows them all, Relaxed skips the ticked ones (none ticked means all).
 * `blocks`: a page that refused our reader (HTTP 403, 429 or 503) may be opened through Bright Data's Web Unlocker.
 */
export const ACCESS_RULES = ["robots", "ai_optout", "noai", "nosnippet", "terms", "never_read", "blocks"] as const;
export type AccessRule = typeof ACCESS_RULES[number];
/** The ten categories a source map covers, by topic id; each topic's section id is in the playbook. Weather isn't one. */
export const PRIORITY_TOPICS = [
  { id: "crime", label: "Crime, police and safety" },
  { id: "deaths", label: "Obituaries" },
  { id: "events", label: "Events" },
  { id: "home_sales", label: "Real estate and home sales" },
  { id: "sports", label: "Sports, including school sports" },
  { id: "government", label: "Council and government" },
  { id: "schools", label: "Schools" },
  { id: "business", label: "Business" },
  { id: "community", label: "Community" },
  { id: "news", label: "Other news" },
] as const;
export type PriorityTopic = typeof PRIORITY_TOPICS[number]["id"];
export const SEARCH_PROVIDERS = ["serpapi", "searchapi", "brightdata", "exa", "tavily", "fixture"] as const;
export type SearchProvider = typeof SEARCH_PROVIDERS[number];
export const CLASSIFIER_MODES = ["off", "shadow", "jev"] as const;
export type ClassifierMode = typeof CLASSIFIER_MODES[number];

export type RunOptions = {
  /** Independent of discovery flow. Old runs stay rule-based. */
  image_mode?: "illustrated" | "current" | "shadow" | "agentic";
  image_call_budget?: number;
  rebuild?: boolean;
  mode: "autopilot" | "manual";
  /** An edition's flow: agentic adds topic sweeps. */
  flow: "current" | "agentic";
  /** A source map run's flow: agentic adds operator search and the mapping agent. Defaults to `flow`. */
  map_flow?: "current" | "agentic";
  guardrails: "strict" | "exploration";
  guardrails_off: GuardrailGroup[];
  access: "respect" | "relaxed";
  access_ignore: AccessRule[];
  count_history: boolean;
  /** Paid services this run may call, with the maximum calls for each. Absent means no calls. */
  paid: Partial<Record<PaidService, number>>;
  /** Free external services switched off for this run. */
  external_off: FreeService[];
  search_provider: SearchProvider;
  classifier: ClassifierMode;
  topics: PriorityTopic[];
  /**
   * The model check on a map run's sources (named `gemini_check` from when it always ran on Gemini; it runs on the
   * configured models in order). Off for baseline tests (the fixed pipeline alone), locally or deployed. Absent means on.
   */
  gemini_check?: boolean;
  /** Write at most this many stories, across sections: for quick test runs on a local model. */
  story_limit?: number | null;
  /**
   * A map run's search depth. Exhaustive: the agent keeps finding new good sources until every
   * category × search tool goes dry. Enough: it stops once every category has an accepted source.
   * Absent (a run from before it existed) means Enough.
   */
  /** Recorded by runs from #134, which offered Exhaustive or Enough. Every run is exhaustive now. */
  search_depth?: "exhaustive" | "enough";
};
