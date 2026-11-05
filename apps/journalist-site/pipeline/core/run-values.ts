/**
 * Run option names and defaults, with no server imports, so the kick-off panel and the
 * pipeline read the same lists.
 */
export const PAID_SERVICES = [
  { id: "gemini", label: "Gemini", use: "Writing, ranking, extraction, discovery", budget: 800 },
  { id: "openai_compatible", label: "OpenAI-compatible APIs", use: "Model fallback, if configured", budget: 200 },
  { id: "tavily", label: "Tavily", use: "Council documents and agent search", budget: 100 },
  { id: "serpapi", label: "SerpApi", use: "Google operator search", budget: 100 },
  { id: "searchapi", label: "SearchApi", use: "Google operator search", budget: 100 },
  { id: "brightdata", label: "Bright Data", use: "Google operator search", budget: 100 },
  { id: "exa", label: "Exa", use: "Coverage comparison search", budget: 50 },
  { id: "scrapingbee", label: "ScrapingBee", use: "JavaScript-rendered pages", budget: 50 },
  { id: "jev", label: "Jev (TypeSafe)", use: "Result, page and item classification", budget: 500 },
  { id: "agent_model", label: "Agent model", use: "Agent planning and extraction on a hosted model", budget: 60 },
  { id: "attom", label: "ATTOM", use: "Home sale prices, if county records are thin", budget: 20 },
] as const;
export type PaidService = typeof PAID_SERVICES[number]["id"];
export const PAID_SERVICE_IDS = PAID_SERVICES.map((service) => service.id) as readonly PaidService[];

export const FREE_SERVICES = [
  { id: "gdelt", label: "GDELT", hosts: ["gdeltproject.org"] },
  { id: "overpass", label: "Overpass (OpenStreetMap)", hosts: ["overpass-api.de", "overpass.kumi.systems", "overpass.private.coffee"] },
  { id: "nominatim", label: "Nominatim (OpenStreetMap)", hosts: ["nominatim.openstreetmap.org"] },
  { id: "socrata", label: "Socrata", hosts: ["api.us.socrata.com"] },
  { id: "nws", label: "National Weather Service", hosts: ["api.weather.gov"] },
  { id: "wikidata", label: "Wikidata", hosts: ["wikidata.org", "query.wikidata.org"] },
  { id: "bluesky", label: "Bluesky", hosts: ["api.bsky.app"] },
  { id: "jina", label: "Jina Reader", hosts: ["r.jina.ai"] },
  { id: "county_records", label: "County assessor and recorder data", hosts: [] },
] as const;
export type FreeService = typeof FREE_SERVICES[number]["id"];

export const GUARDRAIL_GROUPS = ["caps", "quality", "sensitive", "topic_content"] as const;
export type GuardrailGroup = typeof GUARDRAIL_GROUPS[number];
export const ACCESS_RULES = ["robots", "ai_optout", "noai", "nosnippet", "terms"] as const;
export type AccessRule = typeof ACCESS_RULES[number];
export const PRIORITY_TOPICS = [
  { id: "crime", label: "Local crime" },
  { id: "deaths", label: "Death notices" },
  { id: "events", label: "Local events" },
  { id: "home_sales", label: "Home sales and permits" },
  { id: "sports", label: "Local sports" },
] as const;
export type PriorityTopic = typeof PRIORITY_TOPICS[number]["id"];
export const SEARCH_PROVIDERS = ["serpapi", "searchapi", "brightdata", "exa", "tavily", "fixture"] as const;
export type SearchProvider = typeof SEARCH_PROVIDERS[number];
export const CLASSIFIER_MODES = ["off", "shadow", "jev"] as const;
export type ClassifierMode = typeof CLASSIFIER_MODES[number];

export type RunOptions = {
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
  /** Write at most this many stories, across sections: for quick test runs on a local model. */
  story_limit?: number | null;
};
