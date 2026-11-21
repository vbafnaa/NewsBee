import type { PublicationDraft, PublicationDraftStory, PublicationPresentationStory } from "./generation";

export type PublicationReviewHold = { code: string; reviewable: boolean };
export type PublicationHoldResolution = {
  reason: string;
  at: number;
  by: { id: string; email: string };
  flags: string[];
};

const reviewableQualityCodes = new Set([
  "headline_length", "incomplete_headline", "too_many_words", "unfinished_sentence",
  "list_formatting", "repeated_sentence", "repeats_headline", "repeats_when_where", "promotional_language",
]);

export function publicationReviewHolds(flags: string[]): PublicationReviewHold[] {
  return flags.map((code) => ({
    code,
    reviewable: /^(?:(?:headline|summary):)?[a-z_]+$/.test(code)
      && reviewableQualityCodes.has(code.replace(/^(?:headline|summary):/, "")),
  }));
}

export function generatedPublicationStory(draft: PublicationDraft, story: PublicationPresentationStory) {
  return story.origin === "generated"
    ? draft.stories.find((generated) => generated.id === story.generated_story_id)
    : undefined;
}

export function publicationStoryIncluded(draft: PublicationDraft, story: PublicationPresentationStory) {
  return story.included ?? (story.origin === "original" || generatedPublicationStory(draft, story)?.review.status === "ready");
}

export function includedPublicationStories(draft: PublicationDraft) {
  const byId = new Map(draft.presentation.stories.map((story) => [story.id, story]));
  return draft.presentation.story_order
    .map((id) => byId.get(id))
    .filter((story): story is PublicationPresentationStory => Boolean(story && publicationStoryIncluded(draft, story)));
}

export function publicationHoldIsReviewable(generated: PublicationDraftStory) {
  return generated.review.flags.length > 0
    && publicationReviewHolds(generated.review.flags).every((hold) => hold.reviewable);
}

export function publicationStorySafetyError(draft: PublicationDraft, story: PublicationPresentationStory) {
  if (story.origin === "original") return null;
  const generated = generatedPublicationStory(draft, story);
  if (!generated) return "Generated provenance is unavailable; this story cannot be included.";
  if (publicationReviewHolds(generated.review.flags).some((hold) => !hold.reviewable)) {
    return "A hard or unclassified safety hold cannot be overridden. Keep this story excluded.";
  }
  if (generated.review.status !== "held") return null;
  if (!publicationHoldIsReviewable(generated)) return "This hold has no reviewable producer reason. Keep this story excluded.";
  const resolution = story.hold_resolution;
  if (!resolution || typeof resolution.reason !== "string" || !resolution.reason.trim() || resolution.reason.length > 1000
    || !resolution.by?.id || !resolution.by.email || !Number.isFinite(resolution.at) || resolution.at <= 0
    || !Array.isArray(resolution.flags) || resolution.flags.some((flag) => typeof flag !== "string")
    || JSON.stringify([...resolution.flags].sort()) !== JSON.stringify([...generated.review.flags].sort())) {
    return "Resolve the reviewable hold with a reason before including this story.";
  }
  return null;
}

export function publicationSelectionErrors(draft: PublicationDraft) {
  const stories = includedPublicationStories(draft);
  const errors = stories.flatMap((story) => {
    const error = publicationStorySafetyError(draft, story);
    return [
      ...(error ? [`${story.headline || "Untitled story"}: ${error}`] : []),
      ...(story.image_review?.status === "needs_review"
        ? [`${story.headline || "Untitled story"}: resolve the media review by replacing the image or explicitly choosing no image.`]
        : []),
    ];
  });
  const order = draft.presentation.story_order;
  if (order.length !== draft.presentation.stories.length || new Set(order).size !== order.length
    || draft.presentation.stories.some((story) => !order.includes(story.id))) {
    errors.push("Draft story order must contain every retained story exactly once.");
  }
  if (stories.some((story) => !draft.presentation.sections.some((section) => section.id === story.section_id)
    || draft.presentation.section_order.filter((id) => id === story.section_id).length !== 1)) {
    errors.push("Every included story requires a valid, ordered section.");
  }
  if (!stories.length) errors.push("Include at least one story before approval or preview.");
  return errors;
}
