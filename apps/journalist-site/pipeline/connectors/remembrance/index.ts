/**
 * Death notices from two permitted routes only:
 *   - remembrance:family  - notices families submit on the reader site, after an editor approves them;
 *   - funeral-home or publisher feeds an editor adds as a source link in the journalist
 *     portal, each saved with a note recording the republication permission.
 * Legacy.com and newspaper obituary pages are never read. Notices are written exactly as
 * submitted: the writer may not add causes, ages, family details or service arrangements.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { addDays, httpsLink, plainText } from "../common";
import type { CollectedEvent, Connector, ConnectorContext, SourceResult, SourceTask } from "../types";
import { parseNewsFeed, publishedText, sha256 } from "../wider/adapters";
import { fetchBytes, runCollector, skip, SourceUnavailable } from "../parents/shared";
import { townName } from "../locality";
import { rangesFor } from "../../core/time";
import * as ranking from "../../ranking/exploration";
import { REMEMBRANCE_COLLECTION, validateRemembrance, type RemembranceSubmission } from "../../../../../shared/remembrance";
import { itemCap } from "../../core/run-options";

export const LOOKBACK_DAYS = 14;
export const MAX_ITEMS = 8;
const ACCEPT_FEED = "application/rss+xml, application/atom+xml, application/xml, text/xml";


export function remembranceSubmissions(db: Db) { return db.collection<RemembranceSubmission>(REMEMBRANCE_COLLECTION); }

/** Stores a family submission as pending (the reader site calls the same validation). */
export async function submitRemembrance(db: Db, location: { id: string; name: string }, input: unknown) {
  const checked = validateRemembrance(input);
  if ("error" in checked) throw new Error(`Invalid submission: ${checked.error}`);
  const submission: RemembranceSubmission = { _id: randomUUID(), location_id: location.id, location_name: location.name, ...checked.input, status: "pending", submitted_at: new Date().toISOString() };
  await remembranceSubmissions(db).insertOne(submission);
  return submission;
}
export async function listRemembrance(db: Db, status: RemembranceSubmission["status"] | "all" = "pending", locationId?: string) {
  return remembranceSubmissions(db).find({ ...(status === "all" ? {} : { status }), ...(locationId ? { location_id: locationId } : {}) }).sort({ submitted_at: -1 }).limit(200).toArray();
}
export async function decideRemembrance(db: Db, id: string, decision: "approved" | "rejected", editor: string, reason?: string) {
  const result = await remembranceSubmissions(db).findOneAndUpdate(
    { _id: id },
    { $set: { status: decision, decided_at: new Date().toISOString(), decided_by: editor, reason: reason?.slice(0, 300) ?? null } },
    { returnDocument: "after" },
  );
  if (!result) throw new Error(`Invalid submission id: ${id}`);
  return result;
}

export const remembranceConnector: Connector = {
  type: "remembrance",
  meta: {
    name: "Remembrances",
    formats: "Family-submitted death notices approved by an editor, and editor-added funeral-home feeds with a recorded republication permission",
    manual: true,
    coverage: { group: "local", label: "family-submitted remembrances" },
    storyKinds: ["obituary"],
  },
  window: { back: { since: "last_edition", maxDays: LOOKBACK_DAYS } },
  rank: ranking.remembrance,
  sources() {
    return [
      { source_id: "remembrance:family", name: "Family-submitted remembrances", type: "remembrance" },
    ];
  },
  collect(task, context) { return runCollector(task, context, (record) => collectRemembrance(task, context, record)); },
};

async function collectRemembrance(task: SourceTask, context: ConnectorContext, record: SourceResult): Promise<CollectedEvent[]> {
  const since = rangesFor(context, remembranceConnector.window).back?.[0] ?? addDays(context.today, -LOOKBACK_DAYS);
  const place = context.location.community?.name ?? townName(context.location);
  if (task.source_id === "remembrance:family") {
    record.feed_kind = "family_submissions";
    const approved = await remembranceSubmissions(context.db).find({ location_id: context.location.id, status: "approved" }).toArray();
    const events = approved.flatMap((submission) => {
      const day = (submission.decided_at ?? submission.submitted_at).slice(0, 10);
      if (day < since || day > context.today) { skip(record, "outside_window"); return []; }
      return [familyFacts(submission, day, place)];
    });
    record.detail = `${approved.length} approved family notices for ${place}; ${events.length} approved since ${since}`;
    return events.slice(0, itemCap(MAX_ITEMS));
  }
  const feed = typeof task.params?.manual_feed === "string" ? httpsLink(task.params.manual_feed) : null;
  const permission = typeof task.params?.permission === "string" ? task.params.permission.trim() : "";
  if (!feed) throw new SourceUnavailable("no_feed", "Add a funeral-home feed as a source link, with a note recording its republication permission");
  if (!permission) throw new SourceUnavailable("failed", "This feed has no recorded republication permission");
  const feeds = [{ name: task.name, feed, permission }];
  record.feed_kind = "rss";
  const events: CollectedEvent[] = [];
  for (const source of feeds) {
    const items = parseNewsFeed(await fetchBytes(context, source.feed, ACCEPT_FEED));
    record.pages_checked.push(source.feed);
    for (const item of items) {
      if (item.published_day < since || item.published_day > context.today) { skip(record, "outside_window"); continue; }
      events.push({
        source_event_id: sha256(item.id).slice(0, 16), title: `In memory: ${item.title}`, event_date: item.published_day, schedule_text: publishedText(item.published_day),
        venue: source.name, room: null, source_url: item.link, description: item.summary ? `${source.name} published this notice: ${item.summary}` : null,
        kind: "obituary", tier: "local", section: `Remembering neighbours in ${place}`, signals: { permission: source.permission },
      } as CollectedEvent);
    }
  }
  record.detail = `${feeds.length} permitted notice feeds; ${events.length} notices since ${since}`;
  return events.slice(0, itemCap(MAX_ITEMS));
}

/** The reader site's page for an approved notice (HTTPS, so it passes the source-link check). */
export function noticeUrl(submission: Pick<RemembranceSubmission, "_id" | "location_id">, base = process.env.NEWSBEE_READER_SITE_URL) {
  const reader = httpsLink(base ?? null) ?? "https://newsbee-reader-site.vercel.app/reader";
  return `${reader.replace(/\/$/, "")}/remember?location=${encodeURIComponent(submission.location_id)}&notice=${encodeURIComponent(submission._id)}`;
}
export function familyFacts(submission: RemembranceSubmission, day: string, place: string): CollectedEvent {
  const notice = plainText(submission.notice, 1400) ?? submission.notice;
  return {
    source_event_id: submission._id, title: `In memory: ${submission.person_name}`, event_date: day, schedule_text: publishedText(day),
    venue: "Submitted by the family", room: null,
    source_url: submission.link ?? noticeUrl(submission),
    description: `The family shared this notice with Newsbee: ${notice}`,
    kind: "obituary", tier: "local", section: `Remembering neighbours in ${place}`, signals: { family: 1 },
  } as CollectedEvent;
}
