import { randomUUID } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import {
  ILLUSTRATION_DISCLOSURE,
  ILLUSTRATION_POLICY,
  illustrationAsset,
  planIllustrations,
  savedEditorialIllustration,
  type EditorialIllustration,
} from "../../../../shared/editorial-illustrations";
import { PHOTO_ASSETS, readPhotoAsset, type PhotoAsset, type PhotoBlob } from "../../../../shared/image-assets";
import { publicationContentHash, type PublicationReleaseItem } from "../../../../shared/publication-release";
import type { StoryImage } from "../../../../shared/story-image";
import { publishableStoryImage } from "../images/pipeline";
import { COLLECTIONS } from "../storage/mongo";
import { publicationScopedFilter, type PublicationContext } from "./access";
import type { PublicationDraft } from "./generation";

type PipelineReference = {
  draft_id: string;
  story_id: string;
  location_id: string;
  source_id: string;
};

export type PublicationDraftImage = {
  _id: string;
  publication_id: string;
  draft_id: string;
  story_id: string;
  image: StoryImage;
  illustration?: EditorialIllustration;
  permission?: { editorial: true; archive: true; crop: true };
  authority_confirmed?: true;
  people_permissions_confirmed?: true;
  provenance?: {
    type: "pipeline";
    reference: PipelineReference;
  };
  copied_from?: { image_id: string; draft_id: string };
  created_at: number;
  created_by: { id: string; email: string };
  updated_at: number;
  removed_at: number | null;
  removed_by: { id: string; email: string } | null;
};

export type PublicationImageReview = {
  status: "ready" | "needs_review" | "removed";
  reason: string;
};

export function generatedImageSnapshot(result: Record<string, any>): Record<string, unknown> | null {
  const image = {
    ...(result.image && typeof result.image === "object" ? { image: structuredClone(result.image) } : {}),
    ...(result.image_pipeline && typeof result.image_pipeline === "object" ? { pipeline: structuredClone(result.image_pipeline) } : {}),
    ...(result.illustration && typeof result.illustration === "object" ? { illustration: structuredClone(result.illustration) } : {}),
    ...(result.image_caption ? { caption: result.image_caption } : {}),
    ...(result.image_credit ? { credit: result.image_credit } : {}),
  };
  return Object.keys(image).length ? image : null;
}

async function availableAsset(db: Db, image: StoryImage) {
  if (!image.image_asset_id) return true;
  try {
    const store = {
      asset: (id: string) => db.collection<PhotoAsset>(PHOTO_ASSETS).findOne({ _id: id }),
      blob: (id: string) => db.collection<PhotoBlob>(`${PHOTO_ASSETS}_blobs`).findOne({ _id: id }),
    };
    const variants = await Promise.all([
      readPhotoAsset(store, image.image_asset_id, 960, "desktop"),
      readPhotoAsset(store, image.image_asset_id, 480, "mobile"),
    ]);
    return variants.every((variant) => variant.bytes.length > 0);
  } catch {
    return false;
  }
}

async function reviewedPipelineIllustration(db: Db, reference: PipelineReference) {
  const [entry, edition] = await Promise.all([
    db.collection(COLLECTIONS.editionEntries).findOne({
      edition_id: reference.draft_id, story_id: reference.story_id,
      source_id: reference.source_id, disposition: "checks_passed",
    }),
    db.collection(COLLECTIONS.editions).findOne({
      id: reference.draft_id, location_id: reference.location_id, status: { $in: ["built", "published"] },
    }),
  ]);
  const result = entry?.result;
  const pipeline = result?.image_pipeline;
  const items = edition?.published?.items;
  if (!result?.illustration || !Array.isArray(items) || edition?.published?.media_mode !== "illustrated"
    || pipeline?.status !== "illustrated" || pipeline.policy !== ILLUSTRATION_POLICY || pipeline.provider !== "newsbee_ai") return null;
  const index = items.findIndex((item) => item.story_id === reference.story_id);
  if (index < 0) return null;
  const item = items[index];
  if (item.headline !== result.draft?.headline || item.blurb !== result.draft?.summary
    || item.kind !== (result.story?.kind ?? "event")) return null;
  const canonical = planIllustrations(items, reference.location_id).get(index);
  const saved = savedEditorialIllustration({ ...item, image_alt: result.illustration.alt });
  const reviewed = savedEditorialIllustration({
    illustration_id: result.illustration.id,
    illustration_asset_id: result.illustration.asset_id,
    illustration_policy: result.illustration.policy,
    image_alt: result.illustration.alt,
  });
  if (!canonical || !saved || !reviewed) return null;
  const expected = { ...canonical, asset_id: canonical.asset_id ?? canonical.id };
  if (publicationContentHash(expected) !== publicationContentHash(saved)
    || publicationContentHash(expected) !== publicationContentHash(reviewed)) return null;
  return {
    illustration: saved,
    image: {
      image: illustrationAsset(saved.asset_id ?? saved.id, "/reader"),
      image_alt: saved.alt,
      image_caption: ILLUSTRATION_DISCLOSURE,
      image_credit: "Newsbee · AI-generated illustration",
      image_license: "Newsbee original editorial artwork",
    } satisfies StoryImage,
  };
}

async function reviewedPipelineMedia(db: Db, reference: PipelineReference, illustrated = false) {
  if (illustrated) return reviewedPipelineIllustration(db, reference);
  const image = await publishableStoryImage(
    db, reference.draft_id, reference.story_id, reference.location_id, reference.source_id,
  );
  return image && await availableAsset(db, image) ? { image } : null;
}

export async function publicationImageEligible(db: Db, image: PublicationDraftImage) {
  if (image.removed_at !== null) return false;
  if (image.provenance?.type === "pipeline") {
    const current = await reviewedPipelineMedia(db, image.provenance.reference, Boolean(image.illustration));
    return Boolean(current && publicationContentHash(current) === publicationContentHash({
      image: image.image, ...(image.illustration ? { illustration: image.illustration } : {}),
    }));
  }
  if (image.illustration) return false;
  return image.authority_confirmed === true && image.people_permissions_confirmed === true
    && image.permission?.editorial === true && image.permission.archive === true && image.permission.crop === true
    && await availableAsset(db, image.image);
}

export function publicationImageReleaseFields(row: PublicationDraftImage): Partial<PublicationReleaseItem> {
  if (!row.illustration) return row.image;
  const { image: previewUrl, ...metadata } = row.image;
  return {
    ...metadata,
    illustration_id: row.illustration.id,
    illustration_asset_id: row.illustration.asset_id ?? row.illustration.id,
    illustration_policy: row.illustration.policy,
  };
}

export async function eligiblePublicationImages(db: Db, rows: PublicationDraftImage[]) {
  const eligible = await Promise.all(rows.map((image) => publicationImageEligible(db, image)));
  return rows.filter((_, index) => eligible[index]);
}

export function publicationMediaReview(draft: PublicationDraft, rows: PublicationDraftImage[]) {
  const imageById = new Map(rows.map((image) => [image._id, image]));
  for (const story of draft.presentation.stories) {
    if (story.image_id) {
      const image = imageById.get(story.image_id);
      story.image_review = image?.draft_id === draft._id && image.story_id === story.id
        ? { status: "ready", reason: "Reviewed image attached." }
        : { status: "needs_review", reason: "The attached image or its current rights are unavailable. Replace or remove it." };
    }
  }
  return draft;
}

export async function generatedPublicationImages(db: Db, draft: PublicationDraft) {
  const rows: PublicationDraftImage[] = [];
  for (const presentation of draft.presentation.stories) {
    const story = draft.stories.find((candidate) => candidate.id === presentation.generated_story_id);
    if (!story?.snapshot.image) continue;
    const snapshot = story.snapshot.image;
    const pipeline = snapshot.pipeline as { status?: string } | undefined;
    if (!snapshot.image && !snapshot.illustration && ["not_applicable", "no_image"].includes(pipeline?.status ?? "")) continue;
    let selected: PublicationDraftImage | null = null;
    for (const reference of story.references) {
      const entry = await db.collection(COLLECTIONS.editionEntries).findOne({
        id: reference.entry_id, edition_id: reference.draft_id, story_id: reference.story_id,
      });
      if (!entry || typeof entry.source_id !== "string"
        || publicationContentHash(generatedImageSnapshot(entry.result)) !== publicationContentHash(story.snapshot.image)) continue;
      const pipelineReference = {
        draft_id: reference.draft_id,
        story_id: reference.story_id,
        location_id: reference.location_id,
        source_id: entry.source_id,
      };
      const media = await reviewedPipelineMedia(db, pipelineReference, Boolean(snapshot.illustration));
      if (!media) continue;
      const snapshottedImage = story.snapshot.image.image;
      if (snapshottedImage && !("illustration" in media)
        && publicationContentHash(snapshottedImage) !== publicationContentHash(media.image)) continue;
      selected = {
        _id: randomUUID(), publication_id: draft.publication_id, draft_id: draft._id, story_id: presentation.id,
        ...structuredClone(media),
        provenance: { type: "pipeline", reference: pipelineReference },
        created_at: draft.created_at, created_by: draft.telemetry.actor, updated_at: draft.created_at,
        removed_at: null, removed_by: null,
      };
      break;
    }
    if (selected) {
      rows.push(selected);
      presentation.image_id = selected._id;
      presentation.image_review = { status: "ready", reason: "Reviewed generated image attached." };
    } else {
      presentation.image_review = { status: "needs_review", reason: "Generated media has no currently eligible reviewed image. Add a rights-cleared replacement or continue without an image." };
    }
  }
  return rows;
}

export async function cloneCorrectionImages(
  db: Db, context: PublicationContext, source: PublicationDraft, correction: PublicationDraft, session: ClientSession,
) {
  const sourceStories = new Map(source.presentation.stories.map((story) => [story.id, story]));
  const references = source.presentation.stories.flatMap((story) => story.image_id ? [story.image_id] : []);
  const rows = references.length
    ? await db.collection<PublicationDraftImage>(COLLECTIONS.publicationImages).find(publicationScopedFilter(context, {
      _id: { $in: references }, draft_id: source._id, removed_at: null,
    }), { session }).toArray()
    : [];
  const eligible = await eligiblePublicationImages(db, rows);
  const byId = new Map(eligible.map((image) => [image._id, image]));
  const copies: PublicationDraftImage[] = [];
  for (const story of correction.presentation.stories) {
    const sourceImageId = sourceStories.get(story.id)?.image_id;
    if (!sourceImageId) continue;
    const image = byId.get(sourceImageId);
    if (!image || image.story_id !== story.id) {
      story.image_id = null;
      story.image_review = { status: "needs_review", reason: "The released image or its current rights are unavailable. Review a replacement before attaching media." };
      continue;
    }
    const copy = {
      ...structuredClone(image), _id: randomUUID(), draft_id: correction._id,
      copied_from: { image_id: image._id, draft_id: source._id },
    };
    copies.push(copy);
    story.image_id = copy._id;
    story.image_review = { status: "ready", reason: "Reviewed release image copied to this correction." };
  }
  if (copies.length) await db.collection<PublicationDraftImage>(COLLECTIONS.publicationImages).insertMany(copies, { session });
}
