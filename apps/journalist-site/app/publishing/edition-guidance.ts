import type { PublicationDraft } from "@/pipeline/publications/generation";
import { includedPublicationStories, publicationStorySafetyError } from "@/pipeline/publications/inclusion";
import { storySources } from "../../../../shared/source-attribution";

export function editionNextStage(status: PublicationDraft["editorial_status"]) {
  return status === "editing" ? "#editorial-workspace-title" : "#editorial-publish-title";
}

// Advisory copy checks only; readiness and publication remain server-authoritative.
export function editionEssentials(draft: PublicationDraft) {
  const missing: Array<{ href: string; label: string }> = [];
  if (!draft.presentation.headline.trim()) missing.push({ href: "#edition-headline", label: "Add a publication headline." });
  if (!draft.presentation.intro.trim()) missing.push({ href: "#edition-intro", label: "Add a publication introduction." });
  const included = includedPublicationStories(draft);
  if (!included.length) missing.push({ href: "#story-workspace-title", label: "Include at least one story." });
  for (const story of included) {
    const href = `#edition-story-${encodeURIComponent(story.id)}`;
    if (!story.headline.trim() || !story.body.trim()) missing.push({ href, label: `Complete "${story.headline || "Untitled story"}".` });
    if (story.origin === "original" && !story.byline.trim()) missing.push({ href: `#edition-byline-${encodeURIComponent(story.id)}`, label: `Add a byline for "${story.headline || "Untitled story"}".` });
    if (!story.location_tags.length) missing.push({ href: `#edition-locations-${encodeURIComponent(story.id)}`, label: `Choose locations for "${story.headline || "Untitled story"}".` });
    if (!draft.presentation.sections.some((section) => section.id === story.section_id)) missing.push({ href: `#edition-section-${encodeURIComponent(story.id)}`, label: `Choose a section for "${story.headline || "Untitled story"}".` });
    const sourceKeys = story.source_metadata.map((source) => ["web", "document"].includes(source.type)
      ? storySources([{ name: source.name, url: source.url ?? "" }])[0]?.url ?? ""
      : `${source.type}:${source.name.toLowerCase()}:${source.note ?? ""}`);
    if (story.origin === "original" && (!sourceKeys.length || sourceKeys.includes("")
      || new Set(sourceKeys).size !== sourceKeys.length || story.source_metadata.some((source) => !source.name.trim()))) {
      missing.push({ href: `#edition-sources-${encodeURIComponent(story.id)}`, label: `Complete sources for "${story.headline || "Untitled story"}".` });
    }
    if (story.image_review?.status === "needs_review") missing.push({ href: `#edition-image-${encodeURIComponent(story.id)}`, label: `Review the image for "${story.headline || "Untitled story"}".` });
    const safety = publicationStorySafetyError(draft, story);
    if (safety) missing.push({ href, label: `${story.headline || "Untitled story"}: ${safety}` });
  }
  return missing;
}
