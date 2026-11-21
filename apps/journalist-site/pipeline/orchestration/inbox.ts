/**
 * The editor Inbox: everything waiting for an editor's decision, in one list. Held stories
 * (with the rule that held them), reader stories, family notices, reader source
 * suggestions and reader problem reports.
 */
import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import { listReaderStories } from "../connectors/neighbours";
import { listRemembrance } from "../connectors/remembrance";
import { listPublicationSourceFeedback, listSuggestions } from "../connectors/manual-links";
import { runs } from "./runs";
import type { Principal } from "../accounts/identity";
import { hasPublicationCapability } from "../publications/permissions";
import { appendPublicationAccessAudit } from "../publications/audit";
import { locationInScope, scopedLocationFilter, type LocationScope } from "../publications/newsroom-scope";
import type { PublicationDraft } from "../publications/generation";

export const STORY_REPORTS = "story_reports";
export type StoryReport = { _id: string; location_id: string; edition_id: string | null; story_id: string | null; headline: string | null; message: string; status: "open" | "resolved"; submitted_at: string; resolved_at?: string | null; resolved_by?: string | null };
export function storyReports(db: Db) { return db.collection<StoryReport>(STORY_REPORTS); }

/** Held stories in a newsroom's open drafts: each opens in that newsroom's edition editor. */
async function newsroomHeldStories(db: Db, scope: LocationScope) {
  const drafts = await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).find({
    publication_id: scope.publicationId!, editorial_status: { $in: ["editing", "ready_for_approval"] },
  }, { projection: { _id: 1, title: 1, window: 1, editorial_status: 1, stories: 1, "presentation.stories.id": 1, "presentation.stories.generated_story_id": 1 } })
    .sort({ created_at: -1 }).limit(10).toArray();
  return drafts.flatMap((draft) => (draft.stories ?? []).filter((story) => story.review?.status === "held").flatMap((story) => {
    const location = story.location_tags?.[0];
    if (!locationInScope(scope, location?.id)) return [];
    const placed = draft.presentation?.stories?.find((candidate) => candidate.generated_story_id === story.id);
    return [{
      type: "held_story", id: `${draft._id}:${story.id}`, run_id: story.references?.[0]?.run_id ?? null, run_status: draft.editorial_status,
      location_id: location?.id ?? "", location_name: location?.name ?? "", story_id: story.id, title: story.snapshot?.headline || story.id,
      section: story.snapshot?.section ?? null, reasons: story.review.flags ?? [], floor: null,
      draft_id: draft._id, draft_title: draft.title, presentation_story_id: placed?.id ?? null,
    }];
  }));
}

export async function inbox(db: Db, locationId?: string, principal?: Principal, scope?: LocationScope) {
  if (scope?.publicationId) return newsroomInbox(db, scope, locationId);
  const recent = await runs(db).find({
    publication_generation_id: { $exists: false },
    ...(locationId ? { location_id: locationId } : {}),
    draft_id: { $ne: null },
    status: { $in: ["awaiting_finish", "built", "published", "authoring"] },
    created_at: { $gte: Date.now() / 1000 - 14 * 86400 },
  }).sort({ created_at: -1 }).limit(40).toArray();
  const latestByLocation = new Map<string, (typeof recent)[number]>();
  for (const run of recent) if (!latestByLocation.has(run.location_id)) latestByLocation.set(run.location_id, run);
  const held = [];
  const byDraft = new Map([...latestByLocation.values()].filter((run) => run.draft_id).map((run) => [run.draft_id!, run]));
  const entries = byDraft.size ? await db.collection(COLLECTIONS.editionEntries)
    .find({ edition_id: { $in: [...byDraft.keys()] }, disposition: "held" }).toArray() : [];
  for (const entry of entries) {
    const run = byDraft.get(entry.edition_id);
    if (!run) continue;
    held.push({
      type: "held_story", id: `${run._id}:${entry.story_id}`, run_id: run._id, run_status: run.status, location_id: run.location_id, location_name: run.location_name,
      story_id: entry.story_id, title: entry.result?.story?.title ?? entry.story_id, section: entry.section ?? null,
      reasons: entry.result?.validation_errors?.length ? entry.result.validation_errors : entry.result?.error ? [entry.result.error] : [],
      floor: entry.result?.floor?.reason ?? null,
    });
  }
  const ownedPublicationIds = principal ? await db.collection<{ _id: string }>(COLLECTIONS.outputChannels)
    .distinct("_id", { owner_id: principal.id }) : [];
  const privilegedInspection = principal && hasPublicationCapability(principal, "publication:inspect");
  const reviewPublicationIds = privilegedInspection
    ? undefined
    : ownedPublicationIds;
  const [stories, notices, suggestions, feedback, reports] = await Promise.all([
    listReaderStories(db, "pending", locationId), listRemembrance(db, "pending", locationId), listSuggestions(db, "pending", locationId),
    reviewPublicationIds?.length === 0
      ? Promise.resolve([])
      : listPublicationSourceFeedback(db, { status: "pending", locationId, publicationIds: reviewPublicationIds }),
    storyReports(db).find({ status: "open", ...(locationId ? { location_id: locationId } : {}) }).sort({ submitted_at: -1 }).limit(100).toArray(),
  ]);
  if (privilegedInspection) {
    const owned = new Set(ownedPublicationIds);
    for (const publicationId of new Set(feedback.map((item) => item.publication_id).filter((id) => !owned.has(id)))) {
      await appendPublicationAccessAudit(db, {
        publication_id: publicationId,
        principal_id: principal.id,
        principal_email: principal.email,
        capability: "publication:inspect",
        action: "privileged_inspection",
        reason: "Review publication source feedback in the Admin inbox",
      });
    }
  }
  return {
    counts: { held_stories: held.length, reader_stories: stories.length, family_notices: notices.length, suggestions: suggestions.length, source_feedback: feedback.length, reports: reports.length },
    held, reader_stories: stories, family_notices: notices, suggestions, source_feedback: feedback, reports,
  };
}

/** One newsroom's inbox: only its covered communities, and only its own source feedback. */
async function newsroomInbox(db: Db, scope: LocationScope, requested?: string) {
  const locations = scopedLocationFilter(scope, requested);
  const none = Array.isArray(locations) && !locations.length;
  const [held, stories, notices, suggestions, feedback, reports] = none ? [[], [], [], [], [], []] : await Promise.all([
    newsroomHeldStories(db, requested ? { ...scope, locationIds: [requested] } : scope),
    listReaderStories(db, "pending", locations), listRemembrance(db, "pending", locations), listSuggestions(db, "pending", locations),
    listPublicationSourceFeedback(db, { status: "pending", publicationId: scope.publicationId!, ...(requested ? { locationId: requested } : {}) }),
    storyReports(db).find({ status: "open", ...(locations ? { location_id: Array.isArray(locations) ? { $in: locations } : locations } : {}) })
      .sort({ submitted_at: -1 }).limit(100).toArray(),
  ]);
  return {
    counts: { held_stories: held.length, reader_stories: stories.length, family_notices: notices.length, suggestions: suggestions.length, source_feedback: feedback.length, reports: reports.length },
    held, reader_stories: stories, family_notices: notices, suggestions, source_feedback: feedback, reports,
  };
}

export async function resolveReport(db: Db, id: string, editor: string) {
  const result = await storyReports(db).updateOne({ _id: id }, { $set: { status: "resolved", resolved_at: new Date().toISOString(), resolved_by: editor } });
  if (!result.matchedCount) throw new Error(`Unknown report: ${id}`);
  return { resolved: id };
}
