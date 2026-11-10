import type { StoryImage } from "./story-image";
import { allowsContextPhoto } from "./photo-presentation";

export type PhotoStoryContext = {
  kind?: string;
  headline?: string | null;
  summary?: string | null;
  blurb?: string | null;
  description?: string | null;
  when_where?: string | null;
  venues?: string[];
};

const words = (value: string) => value.normalize("NFKD").toLowerCase()
  .replace(/\b(st|ave|rd|blvd)\b/g, token => ({ st: "street", ave: "avenue", rd: "road", blvd: "boulevard" })[token]!)
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const includes = (text: string, name: string) => ` ${words(text)} `.includes(` ${words(name)} `);

/** Explicit locative phrases are evidence; incidental mentions of other places are not. */
export function narrativePhotoPlaces(story: PhotoStoryContext): string[] {
  const found = new Set<string>();
  for (const text of [story.description, story.summary, story.blurb, story.when_where].filter((value): value is string => Boolean(value))) {
    for (const match of text.matchAll(/(?:^|[\n.;]\s*|\s)(?:Location|Venue|Where):\s*([^\n.;]+)/g)) {
      const named = match[1].split(",")[0].trim();
      if (!/^\d/.test(named)) found.add(named);
    }
    for (const match of text.matchAll(/\b(?:at|inside|held in)\s+(?:the\s+)?((?:[\p{Lu}][\p{L}\p{N}’'&-]*\s+){1,10}(?:Studios?|Theat(?:er|re)|Library|Park|School|Center|Centre|Hall|Museum|Church|Arena|Stadium|Gymnasium|Branch))\b/gu)) {
      found.add(match[1].trim());
    }
  }
  return [...found];
}

/** Shared by selection, publication and reader delivery; no model can override a conflict. */
export function photoStoryMismatch(story: PhotoStoryContext, photo: Pick<Partial<StoryImage>, "image_role" | "image_place" | "image_subject">, aliases: readonly string[] = []): string | null {
  if (photo.image_subject) {
    if (["public_record", "safety_incident", "court_case", "home_sale", "housing_market", "obituary"].includes(story.kind ?? "")) return "photo_subject_not_allowed_for_story";
    if (![story.headline, story.summary, story.blurb, story.description].some(value => value && includes(value, photo.image_subject!))) return "photo_subject_not_supported_by_story";
  }
  if (!allowsContextPhoto(story.kind, photo.image_role)) return "photo_role_not_allowed_for_story";
  if (photo.image_role === "stock") return null;
  if (!photo.image_role && !photo.image_place) return null;
  const place = photo.image_place?.trim();
  if (!place) return "photo_place_missing";
  const reviewedAliases = aliases.some(name => words(name) === words(place)) ? aliases : [];
  const names = [...new Set([place, ...reviewedAliases].filter(name => words(name).split(" ").length >= 2))];
  const groups = [story.description, story.summary, story.blurb, story.when_where]
    .filter((text): text is string => Boolean(text)).map(text => narrativePhotoPlaces({ description: text })).filter(group => group.length);
  if (photo.image_role !== "area" && groups.some(group => !group.some(reference => names.some(name => includes(name, reference)
    || includes(reference, name) && words(reference).endsWith(words(name)))))) return "photo_venue_conflict";
  const references = [story.headline, story.description, story.summary, story.blurb, story.when_where, ...(story.venues ?? [])]
    .filter((value): value is string => Boolean(value));
  if (!names.some(name => references.some(reference => includes(reference, name)))) return "photo_place_not_supported_by_story";
  return null;
}
