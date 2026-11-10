// A neighborhood's page (pages/[location_id].astro): the latest published edition for the
// location, read the same way the rest of the reader reads it (readerData: the local Drive
// folder in local mode, Google Drive in cloud mode), mapped onto the page's sections.
import { readerData, type Edition, type EditionItem, type Location } from "./reader-data";
import { TOPICS, topicOf, topicShort } from "../../../../shared/topics";

import { normalizeStoryImage, type StoryImage } from "../../../../shared/story-image";
import { allowsContextPhoto } from "../../../../shared/photo-presentation";
import { photoStoryMismatch } from "../../../../shared/photo-story-match";
import { planIllustrations, type EditorialIllustration } from "../../../../shared/editorial-illustrations";
import { readerMediaMode } from "./reader-media-mode";
export type ArticlePhoto = StoryImage & { src: string };

const EVENT_KINDS = ["event", "meeting_preview"];
const TOP_STORIES = 5;

/** Card label for stories without a topic (shared/contracts/edition.schema.json kinds). */
const KIND_LABELS: Record<string, string> = {
  meeting_outcome: "Civic",
  court_case: "Courts",
  safety_notice: "Safety",
  safety_incident: "Safety",
  public_record: "Public record",
  weather_alert: "Weather",
  earthquake: "Earthquake",
  trending_topic: "Trending",
  social_trend: "Trending",
  obituary: "Remembrance",
  school_sports: "Sports",
  game_result: "Sports",
  home_sale: "Home sales",
  building_permit: "Permits",
  reader_story: "From neighbours",
};

export const TIME_ZONE = "America/Los_Angeles";

/** live: read from the web now · saved: saved copy · pipeline: published edition · fallback: pipeline mode, but the edition had nothing for this section */
export type DataSource = "live" | "saved" | "pipeline" | "fallback";

/** storyId: the edition item's id, for the reading signals (api/engagement.ts); feeds have none. */
export type Story = { title: string; dek: string; category: string; date: string; href: string; storyId?: string | null; photo?: ArticlePhoto; illustration?: EditorialIllustration };
/** dek and where: the edition's summary and venue (events pages); feeds leave them out. */
export type EventItem = { title: string; category: string | null; time: string; href: string | null; dek?: string; where?: string | null; storyId?: string | null; photo?: ArticlePhoto; illustration?: EditorialIllustration };
export type EventDay = { date: string; weekday: string; dayOfMonth: number; isToday: boolean; events: EventItem[] };
export type NewsroomTab = {
  id: string;
  label: string;
  source: DataSource;
  stories: { title: string; dek: string; date: string; sourceName: string; href: string; storyId?: string | null; photo?: ArticlePhoto; illustration?: EditorialIllustration }[];
};
/** One event before grouping by day. `start` is Pacific wall-clock "YYYY-MM-DD HH:MM" or a bare date. */
export type RawEvent = { title: string; start: string; timeKnown: boolean; category: string | null; href: string | null; dek?: string; where?: string | null; storyId?: string | null; photo?: ArticlePhoto; illustration?: EditorialIllustration };

export type PipelineStory = { title: string; dek: string; category: string; isoDate: string; sourceName: string; href: string; storyId: string | null; photo?: ArticlePhoto; illustration?: EditorialIllustration };
export type PipelineEvent = { title: string; isoDate: string; time: string | null; category: string | null; href: string | null; dek: string; where: string | null; storyId: string | null; photo?: ArticlePhoto; illustration?: EditorialIllustration };
export type PipelineEdition = {
  id: string;
  publishedAt: number;
  windowStart: string;
  topStories: PipelineStory[];
  events: PipelineEvent[];
  /** Stories per topic id (shared/topics.ts), in rank order, including any on the front. */
  sections: Record<string, PipelineStory[]>;
};

const byRank = (a: EditionItem, b: EditionItem) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);

/** The item's reader topic (shared/topics.ts), from its kind, headline and summary. */
function topic(item: EditionItem) {
  return topicOf({ kind: item.kind, title: item.headline, description: item.blurb });
}

/** "Filed Friday, October 23. Source: Ballard permit records." → "Ballard permit records" */
function sourceName(item: EditionItem) {
  const named = item.when_where.match(/Source:\s*([^.]+(?:\.[a-z]{2,4})?)/i)?.[1];
  const publisher = item.when_where.match(/\bby\s+([^.]+)\.?$/)?.[1];
  return (named ?? publisher ?? item.source_name ?? "Source").trim();
}

export function articleKey(item: EditionItem, index: number) {
  return item.story_id || `item:${index + 1}`;
}

function articleHref(edition: Edition, item: EditionItem) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const params = new URLSearchParams({
    location: edition.location_id, edition: edition.id, story: articleKey(item, edition.items.indexOf(item)),
  });
  return `${base}?${params}`;
}

/** Preserve reader-photo approval/withdrawal routes; proxy other edition photos safely. */
function editionPhoto(item: EditionItem, edition: Edition): ArticlePhoto | null {
  if (readerMediaMode(edition.media_mode) !== "photos") return null;
  if (!item.image_credit?.trim()) return null;
  const media = normalizeStoryImage(item, item);
  if (!media?.image_source_url) return null;
  if (!allowsContextPhoto(item.kind, media.image_role)) return null;
  if (photoStoryMismatch(item, media)) return null;
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const params = new URLSearchParams({ edition: edition.id, item: String(edition.items.indexOf(item)) });
  return { ...media, src: item.kind === "reader_story" && !media.image_asset_id ? media.image : base + "/api/images/" + encodeURIComponent(edition.location_id) + "?" + params };
}

function toStory(item: EditionItem, edition: Edition, illustration?: EditorialIllustration): PipelineStory {
  const photo = editionPhoto(item, edition);
  return {
    title: item.headline,
    dek: item.blurb,
    category: topicShort(topic(item)) ?? KIND_LABELS[item.kind ?? ""] ?? "News",
    isoDate: item.event_date,
    sourceName: sourceName(item),
    href: articleHref(edition, item),
    storyId: item.story_id ?? null,
    ...(illustration ? { illustration } : {}),
    ...(photo ? { photo } : {}),
  };
}

/** "When: Tuesday, October 27, 2 – 3:30pm. Where: …" → "14:00" (start time, 24h), or null. */
function startTime(whenWhere: string) {
  const match = whenWhere.match(/When:[^,]*,[^,]*,\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*[–-]\s*\d{1,2}(?::\d{2})?\s*(am|pm))?/i);
  if (!match) return null;
  const meridiem = (match[3] ?? match[4] ?? "am").toLowerCase();
  const hours = (Number(match[1]) % 12) + (meridiem === "pm" ? 12 : 0);
  return `${String(hours).padStart(2, "0")}:${match[2] ?? "00"}`;
}

/** "… Where: Conor Byrne Pub, 5140 Ballard Ave NW, Seattle." → "Conor Byrne Pub" */
function venue(whenWhere: string) {
  return whenWhere.match(/Where:\s*([^,.]+)/)?.[1]?.trim() || null;
}

function toEvent(item: EditionItem, edition: Edition, illustration?: EditorialIllustration): PipelineEvent {
  const photo = editionPhoto(item, edition);
  const library = /library/i.test(item.source_name ?? "");
  return {
    title: item.headline,
    isoDate: item.event_date,
    time: startTime(item.when_where),
    category: library ? "Library" : item.kind === "meeting_preview" ? "Civic" : null,
    href: articleHref(edition, item),
    dek: item.blurb,
    where: venue(item.when_where),
    storyId: item.story_id ?? null,
    ...(illustration ? { illustration } : {}),
    ...(photo ? { photo } : {}),
  };
}

function editionIllustrations(edition: Edition) {
  return readerMediaMode(edition.media_mode) === "illustrated" ? planIllustrations(edition.items, edition.location_id) : new Map<number, EditorialIllustration>();
}

function pipelineEdition(edition: Edition, illustrations = editionIllustrations(edition)): PipelineEdition {
  const items = [...edition.items].sort(byRank);
  const news = items.filter((item) => !EVENT_KINDS.includes(item.kind ?? ""));
  return {
    id: edition.id,
    publishedAt: edition.published_at,
    windowStart: edition.window_start,
    // The front is the best-ranked news of any topic; sections leave those out.
    topStories: news.slice(0, TOP_STORIES).map((item) => toStory(item, edition, illustrations.get(edition.items.indexOf(item)))),
    events: items.filter((item) => EVENT_KINDS.includes(item.kind ?? "")).map((item) => toEvent(item, edition, illustrations.get(edition.items.indexOf(item)))),
    sections: Object.fromEntries(TOPICS.map(({ id }) => [id, news.filter((item) => topic(item) === id).map((item) => toStory(item, edition, illustrations.get(edition.items.indexOf(item))))])),
  };
}

function selectEdition(editions: Edition[], locationId: string, editionId?: string | null) {
  return editions
    .filter((edition) => edition.location_id === locationId && (!editionId || edition.id === editionId))
    .sort((a, b) => b.published_at - a.published_at)[0];
}

/** The latest or explicitly selected published edition, scoped to its location. */
export async function loadPipelineEdition(locationId: string, editionId?: string | null): Promise<PipelineEdition | null> {
  const { editions } = await readerData();
  const edition = selectEdition(editions, locationId, editionId);
  return edition ? pipelineEdition(edition) : null;
}

// ---------- dates and events ----------

export const pacificDate = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(date);
export const shortDate = (date: Date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: TIME_ZONE }).format(date);
export const longDate = (date: Date) => new Intl.DateTimeFormat("en-US", {
  weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: TIME_ZONE,
}).format(date);

export function addDays(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function clockLabel(hhmm: string) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour = hours % 12 || 12;
  return minutes ? `${hour}:${String(minutes).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

/** The calendars rarely set categories, so derive a short one from the title. */
const EVENT_CATEGORIES: [RegExp, string][] = [
  [/trivia|bingo|cribbage|game|commander|mahjong|chess/i, "Games"],
  [/story ?time|toddler|kids|family|teen/i, "Kids"],
  [/book|reading|author|genealogy|library/i, "Books"],
  [/music|concert|band|jazz|karaoke|dj\b|open mic/i, "Music"],
  [/class|workshop|lesson|embroidery|craft|drop-in/i, "Classes"],
  [/halloween|costume|trick|spooky|creep/i, "Halloween"],
  [/market|sale|pop-?up/i, "Market"],
  [/movie|film|screening/i, "Film"],
  [/run\b|walk|hike|yoga|fitness|bike/i, "Outdoors"],
];

export const eventCategory = (title: string, given?: string) =>
  given ?? EVENT_CATEGORIES.find(([pattern]) => pattern.test(title))?.[1] ?? null;

/** Seven days from firstDay, each with its events: timed ones first, in start order. */
export function groupByDay(events: RawEvent[], firstDay: string, todayDate: string): EventDay[] {
  const seen = new Set<string>();
  const unique = events.filter((event) => {
    const key = `${event.start.slice(0, 10)}|${event.title.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return Array.from({ length: 7 }, (_, offset) => {
    const date = addDays(firstDay, offset);
    const noon = new Date(`${date}T12:00:00Z`);
    return {
      date,
      weekday: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(noon),
      dayOfMonth: noon.getUTCDate(),
      isToday: date === todayDate,
      events: unique
        .filter((event) => event.start.startsWith(date))
        .sort((a, b) => Number(b.timeKnown) - Number(a.timeKnown) || a.start.localeCompare(b.start))
        .map((event) => ({
          title: event.title,
          category: event.category,
          time: event.timeKnown ? clockLabel(event.start.slice(11, 16)) : "Time TBD",
          href: event.href,
          dek: event.dek,
          where: event.where,
          storyId: event.storyId, ...(event.photo ? { photo: event.photo } : {}), ...(event.illustration ? { illustration: event.illustration } : {}),
        })),
    };
  });
}

/** The edition's events in the shape groupByDay takes. */
export function editionEvents(edition: PipelineEdition): RawEvent[] {
  return edition.events.map((event) => ({
    title: event.title,
    start: event.time ? `${event.isoDate} ${event.time}` : event.isoDate,
    timeKnown: Boolean(event.time),
    category: event.category ?? eventCategory(event.title),
    href: event.href,
    dek: event.dek,
    where: event.where,
    storyId: event.storyId, ...(event.photo ? { photo: event.photo } : {}), ...(event.illustration ? { illustration: event.illustration } : {}),
  }));
}

/** Topic sections from the edition, leaving out stories already in Top News; empty ones dropped. */
export function editionSections(edition: PipelineEdition, onFront: (href: string) => boolean): NewsroomTab[] {
  return TOPICS.map(({ id, label }) => ({
    id, label, source: "pipeline" as DataSource,
    stories: (edition.sections[id] ?? []).filter((story) => !onFront(story.href)).map((story) => ({
      title: story.title, dek: story.dek, sourceName: story.sourceName, href: story.href, storyId: story.storyId, ...(story.photo ? { photo: story.photo } : {}), ...(story.illustration ? { illustration: story.illustration } : {}),
      date: shortDate(new Date(`${story.isoDate}T12:00:00Z`)),
    })),
  })).filter((section) => section.stories.length > 0);
}

export const frontStories = (edition: PipelineEdition): Story[] => edition.topStories.map((story) => ({
  title: story.title, dek: story.dek, category: story.category,
  date: shortDate(new Date(`${story.isoDate}T12:00:00Z`)), href: story.href, storyId: story.storyId, ...(story.photo ? { photo: story.photo } : {}), ...(story.illustration ? { illustration: story.illustration } : {}),
}));

const linkKey = (href: string) => href.replace(/\/$/, "");

// ---------- a neighborhood's page ----------

export type EditionPage = {
  location: Location;
  requestedEditionId?: string | null;
  /** "Ballard" for "Ballard, Seattle, WA". */
  town: string;
  /** Parts of the main page that have something to show (nav and footer links). */
  visible: string[];
  /** Other published neighborhoods, for the footer. */
  neighborhoods: Location[];
  today: string;
  edition: { id: string; publishedAt: number; windowStart: string; windowEnd: string; mediaMode?: "illustrated" | "photos" | "none"; coverage: string[]; corrections: { reason: string; created_at: number }[] };
  sources: Pick<EditionItem, "source_url" | "source_name" | "headline" | "story_id">[];
  articles: Article[];
  topStories: Story[];
  eventDays: EventDay[];
  /** Topic sections for the page, without the Top News stories. */
  sections: NewsroomTab[];
  /** Every story in each topic, Top News included (the section pages). */
  allSections: NewsroomTab[];
};

export type Article = {
  key: string;
  storyId: string | null;
  headline: string;
  text: string;
  whenWhere: string;
  date: string;
  category: string;
  href: string;
  sourceName: string;
  sourceUrl: string | null;
  image: string | null;
  imageCaption: string | null;
  imageCredit: string | null;
  photo?: ArticlePhoto; illustration?: EditorialIllustration;
};

function publicUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** The page for a location, or null when the location is unknown or has no published edition. */
export async function loadEditionPage(locationId: string, editionId?: string | null, now = new Date()): Promise<EditionPage | null> {
  const { locations, editions } = await readerData();
  const location = locations.find((candidate) => candidate.id === locationId);
  const published = new Set(editions.map((edition) => edition.location_id));
  const latest = selectEdition(editions, locationId, editionId);
  if (!location || !latest) return null;
  const illustrations = editionIllustrations(latest);
  const edition = pipelineEdition(latest, illustrations);

  const todayDate = pacificDate(now);
  const topStories = frontStories(edition);
  const onFront = new Set(topStories.map((story) => linkKey(story.href)));
  // The week view starts on the edition's first day, which can be before today.
  const eventDays = groupByDay(editionEvents(edition), latest.window_start.slice(0, 10), todayDate);
  const sections = editionSections(edition, (href) => onFront.has(linkKey(href)));
  return {
    location,
    requestedEditionId: editionId || null,
    town: location.name.split(",")[0].trim(),
    visible: [
      ...(topStories.length ? ["top-news"] : []),
      ...(eventDays.some((day) => day.events.length > 0) ? ["events"] : []),
      ...sections.map((section) => section.id),
    ],
    neighborhoods: locations.filter((candidate) => published.has(candidate.id)),
    today: longDate(now),
    edition: {
      id: latest.id, publishedAt: latest.published_at, windowStart: latest.window_start, windowEnd: latest.window_end,
      mediaMode: readerMediaMode(latest.media_mode),
      coverage: latest.coverage ?? [], corrections: latest.corrections ?? [],
    },
    sources: [...latest.items].sort(byRank).map(({ source_url, source_name, headline, story_id }) => ({
      source_url, source_name, headline, story_id,
    })),
    articles: latest.items.map((item, index) => {
      const photo = editionPhoto(item, latest);
      const illustration = illustrations.get(index);
      return ({
      key: articleKey(item, index), storyId: item.story_id ?? null,
      ...(illustration ? { illustration } : {}),
    ...(photo ? { photo } : {}),
      headline: item.headline, text: item.blurb, whenWhere: item.when_where,
      date: shortDate(new Date(`${item.event_date}T12:00:00Z`)),
      category: topicShort(topic(item)) ?? KIND_LABELS[item.kind ?? ""] ?? (EVENT_KINDS.includes(item.kind ?? "") ? "Events" : "News"),
      href: articleHref(latest, item), sourceName: sourceName(item), sourceUrl: publicUrl(item.source_url),
      image: photo?.src ?? null,
      imageCaption: item.image_caption ?? null, imageCredit: item.image_credit ?? null,
    }); }),
    topStories,
    eventDays,
    sections,
    allSections: editionSections(edition, () => false),
  };
}

/** Reader URLs for a neighborhood: its page, sub-pages, and the shared signup pages. */
export function neighborhoodLinks(page: Pick<EditionPage, "location" | "requestedEditionId">) {
  const home = import.meta.env.BASE_URL.replace(/\/$/, "");
  const id = encodeURIComponent(page.location.id);
  const pageHref = `${home}?location=${id}${page.requestedEditionId ? `&edition=${encodeURIComponent(page.requestedEditionId)}` : ""}`;
  return {
    home,
    page: pageHref,
    section: (topic: string) => `${pageHref}&section=${topic}`,
    events: (date?: string) => `${pageHref}&section=events${date ? `&day=${date}` : ""}`,
    subscribe: `${home}/subscribe?location=${id}`,
    remember: `${home}/remember?location=${id}`,
    share: `${home}/share?location=${id}`,
    suggest: `${home}/suggest?location=${id}`,
  };
}
