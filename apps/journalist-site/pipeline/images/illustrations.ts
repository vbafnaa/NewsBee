import type { Db } from "mongodb";
import { planIllustrations, ILLUSTRATION_POLICY } from "../../../../shared/editorial-illustrations";
import { COLLECTIONS } from "../storage/mongo";
import { recordDecision } from "../trace/decisions";

/** Prepare a subject match; edition assembly allocates distinct artwork across the final items. */
export async function processIllustrationStory(db: Db, draftId: string, storyId: string) {
  const entries = db.collection(COLLECTIONS.editionEntries);
  const entry = await entries.findOne({ edition_id: draftId, story_id: storyId, disposition: "checks_passed" });
  if (!entry) return { story_id: storyId, status: "not_applicable", reason: "story_not_publishable" };
  const story = { ...entry.result?.story, headline: entry.result?.draft?.headline, blurb: entry.result?.draft?.summary };
  const illustration = planIllustrations([story]).get(0);
  const status = illustration ? "illustration_planned" : "not_applicable";
  const reason = illustration ? "reviewed_artwork_subject_match" : "no_suitable_editorial_illustration";
  await entries.updateOne({ _id: entry._id, disposition: "checks_passed" }, { $set: {
    "result.image_pipeline": { status, reason, provider: "newsbee_ai", policy: ILLUSTRATION_POLICY, checked_at: Date.now() },
  } });
  await recordDecision({ stage: "plan", actor: "rule", subject: `image:${draftId}:${storyId}`, decision: status, reason, rule: ILLUSTRATION_POLICY,
    evidence: { story_id: storyId, illustration_id: illustration?.id ?? null, generation_calls: 0, photo_searches: 0 } });
  return { story_id: storyId, status, reason };
}
