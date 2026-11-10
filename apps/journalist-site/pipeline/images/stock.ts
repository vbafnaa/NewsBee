import { reviewLicensedPhoto, searchCommonsPhotos, type CommonsPage, type PhotoCandidate } from "./commons";
import type { HttpTransport } from "../core/http";

const TOPICS = [
  { id: "board_games", label: "Board games", match: /\b(board games?|tabletop games?|chess)\b/i, query: '"board games"' },
  { id: "gardening", label: "Gardening", match: /\b(gardening|garden workshop|planting workshop|seed swap)\b/i, query: '"gardening"' },
  { id: "crafts", label: "Craft activities", match: /\b(knitting|crochet|craft workshop|crafting|pottery workshop)\b/i, query: '"craft workshop"' },
] as const;
export type StockTopic = (typeof TOPICS)[number];

/** Narrow, neutral activities only: no portraits, allegations, memorials or record substitutions. */
export function stockTopic(story: { kind?: string; title?: string; description?: string | null }): StockTopic | null {
  if (story.kind !== "event") return null;
  const text = `${story.title ?? ""} ${story.description ?? ""}`;
  if (/\b(crime|police|arrest|fire|rescue|injur\w*|death|memorial|obituar\w*|funeral|census|permit|court|religio\w*|worship|prayer|meditation|therapy|diagnos\w*)\b/i.test(text)) return null;
  return TOPICS.find(topic => topic.match.test(text)) ?? null;
}

export function reviewStockPhoto(page: CommonsPage, topic: StockTopic, today = new Date()): PhotoCandidate {
  const description = page.imageinfo?.[0]?.extmetadata?.ImageDescription?.value;
  if (!topic.match.test(`${page.title ?? ""} ${typeof description === "string" ? description.replace(/<[^>]*>/g, " ") : ""}`))
    return { title: page.title ?? "", accepted: false, reason: "stock_topic_mismatch" };
  return reviewLicensedPhoto(page, { role: "stock", alt: `${topic.label} (stock photo)`,
    caption: `${topic.label}. General activity context only.` }, today);
}

export async function discoverStockPhotos(topic: StockTopic, today = new Date(), transport?: HttpTransport): Promise<PhotoCandidate[]> {
  return (await searchCommonsPhotos(`${topic.query} filetype:bitmap`, transport)).map(page => reviewStockPhoto(page, topic, today));
}
