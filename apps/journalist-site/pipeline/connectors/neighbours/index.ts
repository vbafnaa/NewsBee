/**
 * Stories neighbours share on the reader site ("Share your story"), after an editor has
 * approved them in the journalist workspace. Each approved story is credited to the
 * neighbour (first name, or "a neighbour") and written like any other item, through the
 * same editorial checks. Upcoming events stay eligible until their date; news is eligible
 * for two weeks after approval.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { addDays, plainText } from "../common";
import type { CollectedEvent, Connector, ConnectorContext, SourceResult, SourceTask } from "../types";
import { publishedText } from "../wider/adapters";
import { runCollector, skip } from "../parents/shared";
import { townName } from "../locality";
import { rangesFor } from "../../core/time";
import * as ranking from "../../ranking/exploration";
import { creditLine, READER_STORIES_COLLECTION, validateReaderStory, type ReaderStory } from "../../../../../shared/reader-stories";
import { itemCap } from "../../core/run-options";

export const LOOKBACK_DAYS = 14;
export const MAX_ITEMS = 6;

export function readerStories(db: Db) { return db.collection<ReaderStory>(READER_STORIES_COLLECTION); }

export async function submitReaderStory(db: Db, location: { id: string; name: string }, input: unknown, today?: string) {
  const checked = validateReaderStory(input, today);
  if ("error" in checked) throw new Error(`Invalid submission: ${checked.error}`);
  const story: ReaderStory = { _id: randomUUID(), location_id: location.id, location_name: location.name, ...checked.input, status: "pending", submitted_at: new Date().toISOString() };
  await readerStories(db).insertOne(story);
  return story;
}
export async function listReaderStories(db: Db, status: ReaderStory["status"] | "all" = "pending", locationId?: string) {
  return readerStories(db).find({ ...(status === "all" ? {} : { status }), ...(locationId ? { location_id: locationId } : {}) }, { projection: { "image.data": 0 } }).sort({ submitted_at: -1 }).limit(200).toArray();
}
export async function decideReaderStory(db: Db, id: string, decision: "approved" | "rejected", editor: string, reason?: string) {
  const result = await readerStories(db).findOneAndUpdate(
    { _id: id },
    { $set: { status: decision, decided_at: new Date().toISOString(), decided_by: editor, reason: reason?.slice(0, 300) ?? null } },
    { returnDocument: "after" },
  );
  if (!result) throw new Error(`Invalid submission id: ${id}`);
  return result;
}

/** The reader site's page for an approved story, used as its source link when it has none. */
export function storyUrl(story: Pick<ReaderStory, "_id" | "location_id">, base = process.env.NEWSBEE_READER_SITE_URL) {
  const reader = base && /^https:\/\//.test(base) ? base : "https://newsbee-reader-site.vercel.app/reader";
  return `${reader.replace(/\/$/, "")}/share?location=${encodeURIComponent(story.location_id)}&story=${encodeURIComponent(story._id)}`;
}

export function storyImageUrl(story: Pick<ReaderStory, "_id" | "location_id">) {
  const url = new URL(storyUrl(story));
  url.pathname = `${url.pathname.replace(/\/share$/, "")}/api/locations/${encodeURIComponent(story.location_id)}/stories/${encodeURIComponent(story._id)}/image`;
  url.search = "";
  return url.href;
}

export const communityConnector: Connector = {
  type: "community",
  meta: {
    name: "Neighbour stories",
    formats: "Stories readers submit on the reader site, published only after an editor approves them",
    manual: false,
    coverage: { group: "local", label: "stories shared by neighbours" },
    storyKinds: ["reader_story"],
  },
  window: { back: { days: LOOKBACK_DAYS } },
  rank: ranking.community,
  sources(location) {
    return [{ source_id: "community:neighbours", name: `Stories shared by ${location.community?.name ?? townName(location)} neighbours`, type: "community" }];
  },
  collect(task, context) { return runCollector(task, context, (record) => collectStories(task, context, record)); },
};

async function collectStories(_task: SourceTask, context: ConnectorContext, record: SourceResult): Promise<CollectedEvent[]> {
  const since = rangesFor(context, communityConnector.window).back?.[0] ?? addDays(context.today, -LOOKBACK_DAYS);
  const place = context.location.community?.name ?? townName(context.location);
  record.feed_kind = "reader_submissions";
  const approved = await readerStories(context.db).find({ location_id: context.location.id, status: "approved" }).toArray();
  const events: CollectedEvent[] = [];
  for (const story of approved) {
    const approvedDay = (story.decided_at ?? story.submitted_at).slice(0, 10);
    if (story.event_date) {
      if (story.event_date < context.today) { skip(record, "event_passed"); continue; }
    } else if (approvedDay < since || approvedDay > context.today) { skip(record, "outside_window"); continue; }
    events.push(storyFacts(story, place));
  }
  events.sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
  const kept = events.slice(0, itemCap(MAX_ITEMS));
  skip(record, "item_limit", events.length - kept.length);
  record.detail = `${approved.length} approved neighbour stories for ${place}; ${kept.length} current`;
  return kept;
}

export function storyFacts(story: ReaderStory, place: string): CollectedEvent {
  const day = story.event_date ?? (story.decided_at ?? story.submitted_at).slice(0, 10);
  const credit = creditLine(story);
  const text = plainText(story.story, 1600) ?? story.story;
  return {
    source_event_id: story._id, title: story.headline, event_date: day, schedule_text: publishedText(day),
    venue: credit.charAt(0).toUpperCase() + credit.slice(1), room: null, source_url: story.link ?? storyUrl(story),
    description: `${credit.charAt(0).toUpperCase() + credit.slice(1)} shared this with the newsletter: ${text}`,
    kind: "reader_story", tier: "local", section: `From ${place} neighbours`,
    signals: { topic: story.topic, upcoming: story.event_date ? 1 : 0 },
    ...(story.image ? {
      details: { image: storyImageUrl(story) },
      image_caption: story.image.caption, image_credit: story.image.credit,
    } : {}),
  } as CollectedEvent;
}
