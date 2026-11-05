/**
 * Reader topics for news stories: the reader groups an edition's stories into sections by them.
 * A topic comes from the story kind and from words in the headline and summary.
 */
export const TOPICS = [
  { id: "housing", label: "Housing & Development", short: "Housing" },
  { id: "transit", label: "Transit & Getting Around", short: "Transit" },
  { id: "business", label: "Business & Food", short: "Business" },
  { id: "policy", label: "Policy Updates", short: "Policy" },
  { id: "community", label: "Groups & Communities", short: "Community" },
  { id: "schools", label: "Schools", short: "Schools" },
  { id: "sports", label: "Local Sports", short: "Sports" },
  { id: "culture", label: "Culture", short: "Culture" },
] as const;
export type TopicId = (typeof TOPICS)[number]["id"];

/** Kinds whose topic is fixed by their source. */
const KIND_TOPICS: Record<string, TopicId> = {
  development: "housing",
  housing_market: "housing",
  home_sale: "housing",
  building_permit: "housing",
  business_opening: "business",
  meeting_outcome: "policy",
  school_sports: "sports",
  game_result: "sports",
};
/** Kinds that never get a topic section: listings, alerts, courts and remembrances. */
const NO_TOPIC = new Set(["event", "meeting_preview", "weather_alert", "earthquake", "court_case", "obituary", "safety_notice", "safety_incident"]);
/** Posts that are themselves event listings ("Weekly Ballard events calendar", "events roundup"). */
const LISTING = /\bevents? (?:calendar|roundup|round-up|guide|list)\b/i;

/** Whole words or phrases (lower case) that point to each topic. A trailing * matches any ending. */
const WORDS: Record<TopicId, string[]> = {
  housing: ["housing", "houses", "home sales", "homes", "homeowner*", "apartment*", "condo*", "townhome*", "townhouse*", "rent", "rents", "renter*", "tenant*", "landlord*", "real estate", "closed sales", "permit", "permits", "construction", "demolish*", "demolition", "subdivid*", "zoning", "rezon*", "upzon*", "development", "developer*", "units", "adu", "adus", "breaks ground", "groundbreaking", "parcel*", "property"],
  transit: ["transit", "light rail", "sound transit", "link extension", "bus", "buses", "metro", "rapidride", "streetcar", "bike", "bikes", "bicycl*", "pedestrian*", "sidewalk*", "crosswalk*", "traffic", "road", "roads", "roadway*", "bridge", "parking", "ev charger*", "chargers", "charging", "ferry", "ferries", "sdot", "wsdot", "commut*", "detour*", "scooter*", "intersection*", "street safety"],
  business: ["business", "businesses", "shop", "shops", "store", "stores", "boutique*", "restaurant*", "cafe", "cafes", "café", "coffee", "bakery", "bar", "bars", "brewery", "breweries", "brewing", "taproom", "pub", "grocer*", "grocery", "market", "opens", "opening", "reopen*", "closes", "closing", "menu", "chef", "retail*", "licence", "license", "restaurant week", "anniversary", "gym"],
  policy: ["council", "councilmember*", "mayor", "legislation", "ordinance*", "law", "laws", "policy", "policies", "budget", "levy", "ballot", "ballots", "election*", "vote", "votes", "voter*", "voting", "candidate*", "city hall", "legislature", "governor", "regulation*", "public comment", "hearing", "proposal", "regional center plan"],
  community: ["nonprofit*", "non-profit*", "volunteer*", "group", "groups", "association", "society", "grant", "grants", "fundrais*", "donation*", "donat*", "raises", "charity", "mutual aid", "food bank", "pantry", "pantries", "tool library", "walkers", "trick-or-treat*", "cleanup", "sustainable ballard"],
  schools: ["school", "schools", "student*", "teacher*", "classroom*", "principal", "pta", "ptsa", "school board", "school district", "seattle public schools", "sps", "elementary", "middle school", "high school", "kindergarten", "preschool*", "graduat*", "tutor*", "athletic*", "homework", "enrollment", "curriculum"],
  sports: ["athletic*", "varsity", "football", "soccer", "basketball", "volleyball", "baseball", "softball", "wrestling", "swim meet", "track and field", "cross country", "playoff*", "final score", "defeated", "mariners", "seahawks", "sounders", "kraken", "storm", "reign"],
  culture: ["art", "arts", "artist*", "gallery", "galleries", "museum", "music", "musician*", "concert*", "band", "theater", "theatre", "dance", "dancers", "film", "films", "cinema", "festival", "julefest", "poetry", "poet*", "book", "books", "author*", "exhibit*", "mural*", "comedy", "performance*", "opera", "heritage"],
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = Object.fromEntries(Object.entries(WORDS).map(([topic, words]) => [topic,
  new RegExp(`(?<![a-z0-9])(?:${words.map((word) => word.endsWith("*") ? `${escape(word.slice(0, -1))}[a-z]*` : escape(word)).join("|")})(?![a-z0-9])`, "g")])) as Record<TopicId, RegExp>;

function score(text: string, topic: TopicId) {
  return text.match(PATTERNS[topic])?.length ?? 0;
}

/**
 * A story's topic: fixed for some kinds, otherwise the topic whose words appear most (title
 * words count double), ties going to the earlier topic in TOPICS; null when nothing matches.
 */
export function topicOf(story: { kind?: string | null; title: string; description?: string | null }): TopicId | null {
  const kind = story.kind ?? "event";
  if (KIND_TOPICS[kind]) return KIND_TOPICS[kind];
  if (NO_TOPIC.has(kind) || LISTING.test(story.title)) return null;
  const title = story.title.toLowerCase();
  const description = (story.description ?? "").toLowerCase();
  let best: TopicId | null = null;
  let bestScore = 0;
  for (const { id } of TOPICS) {
    const value = 2 * score(title, id) + score(description, id);
    if (value > bestScore) { best = id; bestScore = value; }
  }
  return best;
}

/** One-word label for a story card ("Housing"), or null for stories without a topic. */
export function topicShort(id: string | null | undefined) {
  return TOPICS.find((topic) => topic.id === id)?.short ?? null;
}
