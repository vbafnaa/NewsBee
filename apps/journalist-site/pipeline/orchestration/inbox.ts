/**
 * The editor Inbox: everything waiting for an editor's decision, in one list. Held stories
 * (with the rule that held them), reader stories, family notices, reader source
 * suggestions and reader problem reports.
 */
import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import { listReaderStories } from "../connectors/neighbours";
import { listRemembrance } from "../connectors/remembrance";
import { listSuggestions } from "../connectors/manual-links";
import { runs } from "./runs";

export const STORY_REPORTS = "story_reports";
export type StoryReport = { _id: string; location_id: string; edition_id: string | null; story_id: string | null; headline: string | null; message: string; status: "open" | "resolved"; submitted_at: string; resolved_at?: string | null; resolved_by?: string | null };
export function storyReports(db: Db) { return db.collection<StoryReport>(STORY_REPORTS); }

export async function inbox(db: Db, locationId?: string) {
  const recent = await runs(db).find({ ...(locationId ? { location_id: locationId } : {}), draft_id: { $ne: null }, status: { $in: ["awaiting_finish", "published", "authoring"] }, created_at: { $gte: Date.now() / 1000 - 14 * 86400 } }).sort({ created_at: -1 }).limit(40).toArray();
  const latestByLocation = new Map<string, (typeof recent)[number]>();
  for (const run of recent) if (!latestByLocation.has(run.location_id)) latestByLocation.set(run.location_id, run);
  const held = [];
  for (const run of latestByLocation.values()) {
    const entries = await db.collection(COLLECTIONS.editionEntries).find({ edition_id: run.draft_id, disposition: "held" }).toArray();
    for (const entry of entries) {
      held.push({
        type: "held_story", id: `${run._id}:${entry.story_id}`, run_id: run._id, run_status: run.status, location_id: run.location_id, location_name: run.location_name,
        story_id: entry.story_id, title: entry.result?.story?.title ?? entry.story_id, section: entry.section ?? null,
        reasons: entry.result?.validation_errors?.length ? entry.result.validation_errors : entry.result?.error ? [entry.result.error] : [],
        floor: entry.result?.floor?.reason ?? null,
      });
    }
  }
  const [stories, notices, suggestions, reports] = await Promise.all([
    listReaderStories(db, "pending", locationId), listRemembrance(db, "pending", locationId), listSuggestions(db, "pending", locationId),
    storyReports(db).find({ status: "open", ...(locationId ? { location_id: locationId } : {}) }).sort({ submitted_at: -1 }).limit(100).toArray(),
  ]);
  return {
    counts: { held_stories: held.length, reader_stories: stories.length, family_notices: notices.length, suggestions: suggestions.length, reports: reports.length },
    held, reader_stories: stories, family_notices: notices, suggestions, reports,
  };
}

export async function resolveReport(db: Db, id: string, editor: string) {
  const result = await storyReports(db).updateOne({ _id: id }, { $set: { status: "resolved", resolved_at: new Date().toISOString(), resolved_by: editor } });
  if (!result.matchedCount) throw new Error(`Unknown report: ${id}`);
  return { resolved: id };
}
