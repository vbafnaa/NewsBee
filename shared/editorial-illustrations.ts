import { neighborhoodArt } from "./neighborhood-illustrations";

export const ILLUSTRATION_POLICY = "newsbee-watercolor-v1";
export const ILLUSTRATION_DISCLOSURE = "Original AI-generated editorial artwork. Representative illustration; does not depict the actual people, place or event.";

export const ILLUSTRATIONS = [
  { id: "music", title: "Live music", alt: "Watercolor illustration of an acoustic guitar, microphone and wooden stool.", pattern: /\b(music|concert|guitar|acoustic|jazz|blues|folk)\b/i },
  { id: "books", title: "Books and reading", alt: "Watercolor illustration of an armchair, books and autumn flowers.", pattern: /\b(books?|library|libraries|reading|author|story\s?time|literary)\b/i },
  { id: "permits", title: "Home projects", alt: "Watercolor illustration of a generic house, garden pergola and rolled drawing.", pattern: /\b(pergola|single.family|duplex|home renovation|residential remodel)\b/i },
  { id: "community", title: "Community gardening", alt: "Watercolor illustration of two adult neighbors tending a raised garden bed.", pattern: /\b(garden(?:ing|ers?)?|community garden)\b/i },
  { id: "performance", title: "Mime practice", alt: "Watercolor illustration of a beret, white gloves and rehearsal stool.", pattern: /\b(mimes?)\b/i },
  { id: "comedy", title: "Comedy night", alt: "Watercolor illustration of two microphones and stools on an empty comedy stage.", pattern: /\b(comedy|comedians?|stand.up)\b/i },
  { id: "improv", title: "Improv workshop", alt: "Watercolor illustration of rehearsal chairs and a costume rack with a hat and scarf.", pattern: /\b(improv|improvisation|improvisational)\b/i },
  { id: "trees", title: "Tree planting", alt: "Watercolor illustration of a sapling, spade, watering can and gardening gloves.", pattern: /\b(tree planting|planting trees|forest week|tree stewardship|reforestation)\b/i },
  { id: "civic", title: "Community decisions", alt: "Watercolor illustration of an empty meeting table, chairs and papers.", pattern: /\b(council|ordinance|civic|community meeting|school board|zoning)\b/i },
  { id: "transit", title: "Bus journeys", alt: "Watercolor illustration of an unbranded green bus at a leafy pedestrian crossing.", pattern: /\b(bus(?:es)?|bus lanes?|bus service|bus route)\b/i },
  { id: "sports", title: "Football", alt: "Watercolor illustration of a football and trainers on a patch of grass.", pattern: /\b(football|flag football)\b/i },
  { id: "games", title: "Tabletop games", alt: "Watercolor illustration of a checkerboard, chess pieces and mugs on a table.", pattern: /\b(board games?|tabletop|chess|checkers)\b/i },
  { id: "arts", title: "Arts and crafts", alt: "Watercolor illustration of paints, brushes, yarn and knitting needles.", pattern: /\b(crafts?|knitting|watercolou?r|painting|embroidery|sewing|textiles?)\b/i },
  { id: "improv-prompts", title: "Audience suggestions", alt: "Watercolor illustration of three rehearsal chairs and a basket of blank suggestion slips.", pattern: /\b(improv|improvised|improvisation|theatresports)\b/i },
  { id: "theatre-curtain", title: "A little theater", alt: "Watercolor illustration of an empty wooden stage, a warm spotlight and a terracotta curtain.", pattern: /\b(theatresports|theat(?:er|re)|improv|improvised|comedy)\b/i },
  { id: "theatre-tickets", title: "An evening at the theater", alt: "Watercolor illustration of blank theater tickets, a folded program and opera glasses.", pattern: /\b(theatresports|theat(?:er|re)|improv|improvised|comedy)\b/i },
  { id: "theatre-stage", title: "Ready for the next scene", alt: "Watercolor illustration of an empty rehearsal stage with two stools and a bowl of blank suggestion notes.", pattern: /\b(theatresports|theat(?:er|re)|improv|improvised|comedy)\b/i },
  { id: "comedy-duo", title: "Two-person comedy", alt: "Watercolor illustration of two microphones facing each other beside two mugs on a stool.", pattern: /\b(duo comedy|two.person (?:comedy|improv))\b/i },
  { id: "improv-props", title: "Imagination at play", alt: "Watercolor illustration of a rehearsal prop table with a hat, scarf, empty frame and suitcase.", pattern: /\b(improv|improvised|improvisation|theatresports)\b/i },
  { id: "puppets", title: "Puppet theater", alt: "Watercolor illustration of two handmade fabric hand puppets on a wooden theater shelf.", pattern: /\b(puppets?|puppetry)\b/i },
  { id: "reception", title: "A neighborhood reception", alt: "Watercolor illustration of sparkling water, a blank invitation and autumn flowers on a reception table.", pattern: /\b(reception|gathering|celebration|awards?)\b/i },
  { id: "film", title: "At the movies", alt: "Watercolor illustration of a small film projector, film reel and blank movie tickets.", pattern: /\b(films?|movies?|cinemas?|screens? at|screenings?)\b/i },
  { id: "volunteers", title: "A helping hand", alt: "Watercolor illustration of volunteer gloves, a litter grabber, a blank thank-you card and flowers.", pattern: /\b(volunteers?|volunteering|volunteerism|cleanup|clean.up)\b/i },
  { id: "autumn-park", title: "A walk among the trees", alt: "Watercolor illustration of an empty park bench and a tree-lined path covered in autumn leaves.", pattern: /\b(parks?|fall colou?rs|autumn|leaf peeping)\b/i },
  { id: "soccer", title: "Community soccer", alt: "Watercolor illustration of a soccer ball, boots and a training cone on grass.", pattern: /\b(soccer)\b/i },
  { id: "basketball", title: "On the basketball court", alt: "Watercolor illustration of a basketball and trainers on a small outdoor court.", pattern: /\b(basketball)\b/i },
  { id: "baseball", title: "A day at the ball field", alt: "Watercolor illustration of a leather baseball glove, ball and wooden bat on grass.", pattern: /\b(baseball|softball)\b/i },
  { id: "curling", title: "The spirit of curling", alt: "Watercolor illustration of a granite curling stone and a brush on ice.", pattern: /\b(curling)\b/i },
  { id: "restaurants", title: "A table in the neighborhood", alt: "Watercolor illustration of an empty restaurant table with ceramic plates, napkins and flowers.", pattern: /\b(restaurants?|dining|bistros?|cafes?)\b/i },
  { id: "podcast", title: "A local conversation", alt: "Watercolor illustration of a tabletop microphone, headphones, a blank notebook and coffee.", pattern: /\b(podcasts?)\b/i },
  { id: "halloween", title: "Around the neighborhood at Halloween", alt: "Watercolor illustration of a friendly pumpkin lantern, paper treat bag and autumn leaves.", pattern: /\b(halloween|trick.or.treat|pumpkins?)\b/i },
  { id: "civic-budget", title: "Community budgets", alt: "Watercolor illustration of blank budget papers, a calculator, pencil and small plant on a desk.", pattern: /\b(budgets?|funding|grants?|amendments?|overtime proposal)\b/i },
  { id: "neighborhood-meeting", title: "Neighbors around the table", alt: "Watercolor illustration of a round meeting table, four empty chairs, blank notebooks and mugs.", pattern: /\b((?:board|community|neighborhood|council) meetings?|land use event|public forums?)\b/i },
  { id: "music-keys", title: "A little live music", alt: "Watercolor illustration of a keyboard, microphone and blank music paper.", pattern: /\b(music|concerts?|keyboards?|piano|pop (?:shows?|dry spell))\b/i },
  { id: "event-calendar", title: "Things to do nearby", alt: "Watercolor illustration of a blank desk calendar, invitation, pencil and yellow flowers.", pattern: /\bevents? calendar\b/i },
  { id: "tickets", title: "Save your place", alt: "Watercolor illustration of blank admission tickets, a notebook, coffee and autumn leaves.", pattern: /\b(tickets?|admission|booking)\b/i },
  { id: "civic-housing", title: "Homes and neighborhood plans", alt: "Watercolor illustration of three small wooden model houses, blank planning papers and a pencil.", pattern: /\b(housing|homes?|zoning|land use|development)\b/i },
  { id: "civic-papers", title: "Local proposals", alt: "Watercolor illustration of blank folders, a notebook, pen and blue mug beside a plant.", pattern: /\b(councilmembers?|council|budgets?|amendments?|proposals?|ordinances?|policy)\b/i },
  { id: "film-reel", title: "Independent cinema", alt: "Watercolor illustration of a film reel, cinema seat and blank folded program.", pattern: /\b(films?|movies?|cinemas?|screens? at|screenings?)\b/i },
  { id: "food-kitchen", title: "From a neighborhood kitchen", alt: "Watercolor illustration of a cooking pot, wooden spoon, tomatoes and fresh herbs on a worktop.", pattern: /\b(restaurants?|cooking|culinary|chefs?|kitchens?)\b/i },
] as const;
export type IllustrationId = typeof ILLUSTRATIONS[number]["id"];
export type IllustrationAssetId = IllustrationId | "wedgwood-books" | "moses-lake-football";
export type EditorialIllustration = { id: IllustrationId; asset_id?: IllustrationAssetId; policy: typeof ILLUSTRATION_POLICY; alt: string };
export type IllustrationStory = { headline?: string; title?: string; blurb?: string; summary?: string; description?: string; kind?: string; rank?: number | null };

const excludedKinds = new Set(["public_record", "safety_incident", "safety_notice", "court_case", "obituary", "housing_market", "home_sale", "earthquake", "weather_alert", "reader_story"]);
const sensitive = /\b(police|arrest(?:ed|s)?|homicide|murder|assault|abuse|shooting|stabb(?:ed|ing)|rape|violence|victims?|suicide|fatal|fatalit(?:y|ies)|deaths?|died|injur(?:ed|ies|y)|missing person|census|obituar(?:y|ies)|funerals?|memorial service|celebration of life|vigils?)\b/i;

export function illustrationScore(story: IllustrationStory, id: string): number {
  const illustration = ILLUSTRATIONS.find(entry => entry.id === id);
  const title = story.headline ?? story.title ?? "";
  const body = [story.blurb, story.summary, story.description].filter(Boolean).join(" ");
  if (!illustration || excludedKinds.has(story.kind ?? "") || sensitive.test(`${title} ${body}`) || /\b(cancelled|canceled|postponed)\b/i.test(title)) return 0;
  const residentialPermit = id === "civic-housing" && ["development", "building_permit"].includes(story.kind ?? "")
    && /\b(permit|building)\b/i.test(title) && /\b(recorded|issued|filed)\s+(a|an)\s+(single[ -]family|duplex|residential)\b/i.test(body);
  if (!illustration.pattern.test(title) && !residentialPermit) return id === "event-calendar" && isEvent(story) ? 1 : 0;
  if (id === "music" && /\b(comedy|mimes?|improv|stand.up)\b/i.test(title) && !/\b(musical|guitar|acoustic|jazz|blues|folk)\b/i.test(title)) return 0;
  const specificity = id === "performance" && /\bmimes?\b/i.test(title) || id === "comedy" && /\bcomedy\b/i.test(title) ? 3 : 0;
  return 10 + specificity + (illustration.pattern.test(body) ? 2 : 0);
}

/** Allocate events first, then news, using distinct reviewed assets across every reader view. */
export function planIllustrations(stories: readonly IllustrationStory[], locationId?: string): Map<number, EditorialIllustration> {
  const candidates = stories.map((story, index) => ({ index, rank: story.rank ?? index, event: isEvent(story),
    choices: ILLUSTRATIONS.map(art => ({ art, score: illustrationScore(story, art.id) }))
      .filter(choice => choice.score > 0).sort((a, b) => b.score - a.score),
  }));
  const order = [...candidates].filter(candidate => candidate.choices.length).sort((a, b) =>
    Number(b.event) - Number(a.event) || b.choices[0].score - a.choices[0].score || a.choices.length - b.choices.length || a.rank - b.rank || a.index - b.index);
  const allocated = new Map<number, typeof ILLUSTRATIONS[number]>();
  const owners = new Map<IllustrationId, number>();

  // Reassign a flexible match when its drawing is the only choice for another story.
  function allocate(index: number, visited: Set<IllustrationId>): boolean {
    const choices = candidates[index].choices.filter(({ art }) => !visited.has(art.id));
    const available = choices.find(({ art }) => !owners.has(art.id));
    if (available) {
      allocated.set(index, available.art);
      owners.set(available.art.id, index);
      return true;
    }
    for (const { art } of choices) {
      visited.add(art.id);
      const previous = owners.get(art.id)!;
      if (allocate(previous, visited)) {
        allocated.set(index, art);
        owners.set(art.id, index);
        return true;
      }
    }
    return false;
  }
  for (const { index } of order) allocate(index, new Set());

  const assigned = new Map<number, EditorialIllustration>();
  const neighborhood = neighborhoodArt(locationId ?? "");
  for (const [index, art] of [...allocated].sort(([a], [b]) => a - b)) {
    const localBooks = art.id === "books" && neighborhood?.id === "wedgwood";
    const localFootball = art.id === "sports" && neighborhood?.id === "moses-lake";
    assigned.set(index, { id: art.id, policy: ILLUSTRATION_POLICY, alt: localBooks
      ? "AI watercolor of a cozy reading nook, coffee and books, with leafy Wedgwood-style houses beyond the window."
      : localFootball ? "AI watercolor of a football and trainers with Moses Lake's blue water and golden Columbia Basin landscape suggested behind."
        : art.alt, ...(localBooks ? { asset_id: "wedgwood-books" as const } : localFootball ? { asset_id: "moses-lake-football" as const } : {}) });
  }
  return assigned;
}

function isEvent(story: IllustrationStory) {
  return story.kind === "event" || story.kind === "meeting_preview";
}

export function illustrationAsset(id: IllustrationAssetId, base = "", small = false) {
  if (!ILLUSTRATIONS.some(art => art.id === id) && id !== "wedgwood-books" && id !== "moses-lake-football") throw Error("Unknown editorial illustration");
  return `${base.replace(/\/$/, "")}/illustrations/${id}-v1${small ? "-960" : ""}.webp`;
}
