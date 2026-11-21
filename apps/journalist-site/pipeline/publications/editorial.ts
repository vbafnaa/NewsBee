import { createHash, randomUUID } from "node:crypto";
import { parseBeePuzzle, type BeePuzzle } from "../../../../shared/save-the-bee";
import type { ClientSession, Db, UpdateFilter } from "mongodb";
import { storySources } from "../../../../shared/source-attribution";
import { validateGrantedPhoto } from "../../../../shared/photo-supply";
import type { Principal } from "../accounts/identity";
import { collectedItems, type CollectedItem } from "../editions/assemble";
import type { EvidencePacket } from "../editions/evidence";
import { COLLECTIONS } from "../storage/mongo";
import {
  assertPublicationWrite,
  ensurePublicationIndexes,
  publicationOwnedDocument,
  publicationScopedFilter,
  type PublicationContext,
} from "./access";
import {
  type PublicationDraft,
  type PublicationDraftPresentation,
  type PublicationEditorialSource,
  type PublicationPresentationStory,
} from "./generation";
import {
  eligiblePublicationImages,
  publicationImageEligible,
  publicationMediaReview,
  type PublicationDraftImage,
} from "./media";
import { appendPublicationChangeAudit, publicationChangeTransaction } from "./audit";
import {
  generatedPublicationStory,
  includedPublicationStories,
  publicationHoldIsReviewable,
  publicationSelectionErrors,
  publicationStoryIncluded,
  publicationStorySafetyError,
} from "./inclusion";
export type { PublicationDraftImage } from "./media";

export class PublicationDraftConflict extends Error {
  constructor() {
    super("The draft changed in another editor. Your local edit was kept; refresh the revision before retrying.");
  }
}

export class PublicationDraftNotFound extends Error {
  constructor() {
    super("Publication draft was not found.");
  }
}

export class PublicationDraftValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type PublicationDraftPatch =
  | { type: "draft"; headline?: unknown; intro?: unknown }
  | { type: "bee_game"; game: BeePuzzle | null }
  | { type: "section"; sectionId?: unknown; title?: unknown }
  | { type: "section_order"; sectionIds?: unknown }
  | { type: "story"; storyId?: unknown; headline?: unknown; body?: unknown; byline?: unknown; sectionId?: unknown; locationTags?: unknown; sourceMetadata?: unknown; imageId?: unknown }
  | { type: "story_order"; storyIds?: unknown }
  | { type: "inclusion"; storyId?: unknown; included?: unknown; reason?: unknown }
  | { type: "add_original_story"; storyId?: unknown; story?: unknown }
  | { type: "remove_original_story"; storyId?: unknown }
  | { type: "reopen_for_editing" }
  | { type: "ready_for_approval" };

export type PublicationStoryEvidence = {
  story_id: string;
  review: { status: "ready" | "held"; flags: string[] };
  sources: Array<{ name: string; url: string | null }>;
  items: Array<{
    id: string;
    title: string;
    source_name: string;
    url: string | null;
    evidence?: EvidencePacket;
  }>;
};

export type PublicationInterviewNote = {
  _id: string;
  publication_id: string;
  draft_id: string;
  story_id: string;
  revision: number;
  interviewee: string;
  interviewed_at: string;
  body: string;
  created_at: number;
  created_by: { id: string; email: string };
  updated_at: number;
  updated_by: { id: string; email: string };
};

const now = () => Date.now() / 1000;
const drafts = (db: Db) => db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts);
const images = (db: Db) => db.collection<PublicationDraftImage>(COLLECTIONS.publicationImages);
const notes = (db: Db) => db.collection<PublicationInterviewNote>(COLLECTIONS.publicationInterviewNotes);
const actor = (principal: Pick<Principal, "id" | "email">) => ({ id: principal.id, email: principal.email });

function text(value: unknown, label: string, max: number, required = true, preserve = false) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new PublicationDraftValidationError(`${label} is invalid.`);
  }
  const cleaned = value.replace(/\r\n/g, "\n").trim();
  if (required && !cleaned) throw new PublicationDraftValidationError(`${label} is required.`);
  return preserve ? value : cleaned;
}

function identifier(value: unknown, label: string) {
  const cleaned = text(value, label, 160);
  if (!/^[A-Za-z0-9._:-]+$/.test(cleaned)) throw new PublicationDraftValidationError(`${label} is invalid.`);
  return cleaned;
}

function calendarDate(value: unknown, label: string) {
  const cleaned = text(value, label, 10);
  const parsed = new Date(`${cleaned}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== cleaned) {
    throw new PublicationDraftValidationError(`${label} is invalid.`);
  }
  return cleaned;
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new PublicationDraftValidationError(`${label} is invalid.`);
  }
  return value.map((entry) => entry.trim());
}

function revision(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new PublicationDraftValidationError("Draft revision is invalid.");
  }
  return Number(value);
}

function normalizeSource(
  value: unknown,
  fallbackId: string = randomUUID(),
  requireComplete = true,
): PublicationEditorialSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicationDraftValidationError("Story source metadata is invalid.");
  }
  const raw = value as Record<string, unknown>;
  const type = raw.type;
  if (!["web", "document", "interview", "observation"].includes(String(type))) {
    throw new PublicationDraftValidationError("Story source type is invalid.");
  }
  const name = text(raw.name, "Story source name", 240, requireComplete, !requireComplete);
  const note = raw.note === null || raw.note === undefined ? null : text(raw.note, "Story source note", 1000, false, !requireComplete);
  let url: string | null = null;
  if (type === "web" || type === "document") {
    const rawUrl = raw.url === null || raw.url === undefined
      ? ""
      : text(raw.url, "Story source URL", 4096, false, !requireComplete);
    const normalized = rawUrl ? storySources([{ name: name || "Source", url: rawUrl }])[0] : null;
    if (requireComplete && !normalized) {
      throw new PublicationDraftValidationError("Web and document sources require a public HTTPS URL.");
    }
    url = requireComplete ? normalized?.url ?? null : raw.url == null ? null : rawUrl;
  }
  return {
    id: typeof raw.id === "string" && /^[A-Za-z0-9._:-]+$/.test(raw.id) ? raw.id : fallbackId,
    type: type as PublicationEditorialSource["type"],
    name,
    url,
    note: requireComplete ? note || null : note,
  };
}

function normalizeSources(value: unknown, requireComplete = true, storyId?: string) {
  if (!Array.isArray(value) || requireComplete && !value.length) {
    throw new PublicationDraftValidationError("Original stories require at least one source.");
  }
  const sources = value.map((source, index) => normalizeSource(source, storyId ? `${storyId}-source-${index}` : randomUUID(), requireComplete));
  const keys = sources.map((source) => source.url ?? `${source.type}:${source.name.toLowerCase()}:${source.note ?? ""}`);
  if (requireComplete && new Set(keys).size !== keys.length) {
    throw new PublicationDraftValidationError("Story sources must be unique.");
  }
  return sources;
}

function legacyPresentation(draft: PublicationDraft): PublicationDraftPresentation {
  const sectionIds = [...new Set(draft.stories.map((story) => story.snapshot.section || "news"))];
  const sections = sectionIds.map((id) => ({
    id,
    title: id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
  }));
  const stories = draft.stories.map((story) => ({
    id: story.id,
    origin: "generated" as const,
    generated_story_id: story.id,
    section_id: story.snapshot.section || sectionIds[0] || "news",
    headline: story.snapshot.headline,
    body: story.snapshot.summary,
    byline: "",
    location_tags: story.location_tags.map((location) => location.id),
    source_metadata: story.snapshot.sources.map((source, index) => ({
      id: `${story.id}-source-${index}`,
      type: "web" as const,
      name: source.name,
      url: source.url,
      note: null,
    })),
    image_id: null,
  }));
  return {
    headline: draft.title,
    intro: "",
    sections,
    section_order: sections.map((section) => section.id),
    stories,
    story_order: stories.map((story) => story.id),
  };
}

async function editorialDraft(db: Db, context: PublicationContext, draftId: string) {
  await ensurePublicationIndexes(db);
  let draft = await drafts(db).findOne(publicationScopedFilter(context, { _id: draftId }));
  if (!draft) return null;
  if (!draft.presentation || !Number.isInteger(draft.revision)) {
    const current = now();
    draft = await drafts(db).findOneAndUpdate(
      publicationScopedFilter(context, { _id: draftId, presentation: { $exists: false } }),
      {
        $set: {
          presentation: legacyPresentation(draft),
          revision: 0,
          editorial_status: "editing",
          updated_at: current,
          updated_by: draft.telemetry.actor,
          ready_for_approval_at: null,
          ready_for_approval_by: null,
        },
      },
      { returnDocument: "after" },
    ) ?? await drafts(db).findOne(publicationScopedFilter(context, { _id: draftId }));
  }
  return draft;
}

function ensureEditing(draft: PublicationDraft) {
  if (draft.editorial_status !== "editing") {
    throw new PublicationDraftValidationError("This draft is ready for approval and is no longer editable.");
  }
}

export async function migratePublicationDraftInclusion(
  db: Db,
  context: PublicationContext,
  draft: PublicationDraft,
) {
  if (draft.inclusion_version === 1 || draft.editorial_status === "published" || draft.release) return draft;
  await assertPublicationWrite(db, context, "migrate_publication_inclusion", { audit: false });
  const stories = draft.presentation.stories.map((story) => ({
    ...story,
    included: publicationStoryIncluded(draft, story),
  }));
  const changed = stories.some((story, index) => story.included !== (draft.presentation.stories[index].included ?? true));
  const updated = await drafts(db).findOneAndUpdate(publicationScopedFilter(context, {
    _id: draft._id, revision: draft.revision, editorial_status: draft.editorial_status,
  }), {
    $set: {
      inclusion_version: 1,
      "presentation.stories": stories,
      ...(changed ? {
        editorial_status: "editing" as const, updated_at: now(),
        ready_for_approval_at: null, ready_for_approval_by: null,
      } : {}),
    },
    ...(changed ? { $inc: { revision: 1 }, $unset: { approval: "", publish_claim: "" } } : {}),
  }, { returnDocument: "after" });
  if (!updated) throw new PublicationDraftConflict();
  return updated;
}

function storyAt(draft: PublicationDraft, storyId: string) {
  const index = draft.presentation.stories.findIndex((story) => story.id === storyId);
  if (index < 0) throw new PublicationDraftValidationError("Story was not found in this draft.");
  return { story: draft.presentation.stories[index], index };
}

function validateLocationTags(draft: PublicationDraft, value: unknown, requireLocation = true) {
  const locationTags = [...new Set(stringArray(value, "Story locations"))];
  const allowed = new Set(draft.locations.map((location) => location.id));
  if (requireLocation && !locationTags.length || locationTags.some((id) => !allowed.has(id))) {
    throw new PublicationDraftValidationError("Choose at least one location from this publication draft.");
  }
  return locationTags;
}

function validateOrder(value: unknown, expected: string[], label: string) {
  const order = stringArray(value, label);
  if (order.length !== expected.length || new Set(order).size !== order.length
    || order.some((id) => !expected.includes(id))) {
    throw new PublicationDraftValidationError(`${label} must contain every item exactly once.`);
  }
  return order;
}

function originalStoryId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new PublicationDraftValidationError("Original story ID must be a canonical UUID v4.");
  }
  return value;
}

function storySection(draft: PublicationDraft, value: unknown, allowEmpty = false) {
  const sectionId = allowEmpty && value === "" ? "" : identifier(value, "Story section");
  if (sectionId && !draft.presentation.sections.some((section) => section.id === sectionId)) {
    throw new PublicationDraftValidationError("Story section was not found.");
  }
  return sectionId;
}

function validateOriginalStory(draft: PublicationDraft, id: string, value: unknown, allowIncomplete = true): PublicationPresentationStory {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicationDraftValidationError("Original story is invalid.");
  }
  const raw = value as Record<string, unknown>;
  if ("id" in raw && raw.id !== id) {
    throw new PublicationDraftValidationError("Original story identity does not match.");
  }
  return {
    id,
    origin: "original",
    generated_story_id: null,
    section_id: storySection(draft, raw.sectionId, allowIncomplete),
    headline: text(raw.headline, "Story headline", 240, !allowIncomplete, allowIncomplete),
    body: text(raw.body, "Story body", 20_000, !allowIncomplete, allowIncomplete),
    byline: text(raw.byline, "Story byline", 240, !allowIncomplete, allowIncomplete),
    location_tags: validateLocationTags(draft, raw.locationTags, !allowIncomplete),
    source_metadata: normalizeSources(raw.sourceMetadata, !allowIncomplete, allowIncomplete ? id : undefined),
    image_id: null,
    included: true,
  };
}

async function validateImageReference(db: Db, context: PublicationContext, draft: PublicationDraft, storyId: string, imageId: string | null) {
  if (!imageId) return null;
  const image = await images(db).findOne(publicationScopedFilter(context, {
    _id: imageId,
    draft_id: draft._id,
    story_id: storyId,
    removed_at: null,
  }));
  if (!image || !await publicationImageEligible(db, image)) throw new PublicationDraftValidationError("The selected publication image or its current rights are unavailable.");
  return imageId;
}

export function publicationDraftReadinessErrors(draft: PublicationDraft, draftImages: PublicationDraftImage[]) {
  const errors = publicationSelectionErrors(draft);
  if (draft.presentation.save_the_bee != null) {
    try { parseBeePuzzle(draft.presentation.save_the_bee); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (!draft.presentation.headline.trim()) errors.push("Add a publication headline.");
  if (!draft.presentation.intro.trim()) errors.push("Add a publication introduction.");
  try {
    validateOrder(draft.presentation.section_order, draft.presentation.sections.map((section) => section.id), "Section order");
    validateOrder(draft.presentation.story_order, draft.presentation.stories.map((story) => story.id), "Story order");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const sectionIds = new Set(draft.presentation.sections.map((section) => section.id));
  const locationIds = new Set(draft.locations.map((location) => location.id));
  const imageById = new Map(draftImages.filter((image) => image.removed_at === null).map((image) => [image._id, image]));
  const included = includedPublicationStories(draft);
  const includedSections = new Set(included.map((story) => story.section_id));
  for (const section of draft.presentation.sections.filter((section) => includedSections.has(section.id))) {
    if (!section.title.trim()) errors.push("Complete every section title.");
  }
  for (const story of included) {
    if (!story.headline.trim() || !story.body.trim()) errors.push(`Complete "${story.headline || "Untitled story"}".`);
    if (!sectionIds.has(story.section_id)) errors.push(`Choose a valid section for "${story.headline || "Untitled story"}".`);
    if (!story.location_tags.length || story.location_tags.some((id) => !locationIds.has(id))) {
      errors.push(`Choose valid locations for "${story.headline || "Untitled story"}".`);
    }
    if (story.origin === "original") {
      if (!story.byline.trim()) errors.push(`Add a byline for "${story.headline || "Untitled story"}".`);
      try {
        normalizeSources(story.source_metadata);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (story.image_id && imageById.get(story.image_id)?.story_id !== story.id) {
      errors.push(`Replace the unavailable image for "${story.headline || "Untitled story"}".`);
    }
  }
  return [...new Set(errors)];
}

async function updateDraft(
  db: Db,
  context: PublicationContext,
  draft: PublicationDraft,
  principal: Pick<Principal, "id" | "email">,
  update: UpdateFilter<PublicationDraft>,
  session?: ClientSession,
) {
  const current = now();
  update.$set = {
    ...update.$set,
    updated_at: current,
    updated_by: actor(principal),
  };
  update.$inc = { ...update.$inc, revision: 1 };
  const updated = await drafts(db).findOneAndUpdate(
    publicationScopedFilter(context, {
      _id: draft._id,
      revision: draft.revision,
      editorial_status: "editing",
    }),
    update,
    { returnDocument: "after", session },
  );
  if (!updated) throw new PublicationDraftConflict();
  return updated;
}

async function editorialTransaction<T>(db: Db, handler: (session: ClientSession) => Promise<T>) {
  const session = db.client.startSession();
  try {
    return await session.withTransaction(() => handler(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    }) as T;
  } finally {
    await session.endSession();
  }
}

export async function patchPublicationDraft(
  db: Db,
  context: PublicationContext,
  draftId: string,
  expectedRevision: number,
  operation: PublicationDraftPatch,
  principal: Pick<Principal, "id" | "email">,
) {
  await assertPublicationWrite(db, context, "edit_publication_draft");
  revision(expectedRevision);
  if (!operation || typeof operation !== "object" || Array.isArray(operation) || typeof operation.type !== "string") {
    throw new PublicationDraftValidationError("Draft operation is invalid.");
  }
  const loaded = await editorialDraft(db, context, draftId);
  if (!loaded) throw new PublicationDraftNotFound();
  const draft = await migratePublicationDraftInclusion(db, context, loaded);
  if (operation.type === "add_original_story") {
    if (operation.storyId === undefined) {
      if (draft.revision !== expectedRevision) throw new PublicationDraftConflict();
      ensureEditing(draft);
      const story = validateOriginalStory(draft, randomUUID(), operation.story, false);
      return updateDraft(db, context, draft, principal, {
        $push: { "presentation.stories": story, "presentation.story_order": story.id },
      });
    }
    ensureEditing(draft);
    const story = validateOriginalStory(draft, originalStoryId(operation.storyId), operation.story);
    const requestHash = createHash("sha256").update(JSON.stringify(story)).digest("hex");
    // Keep creation receipts after removal and later edits: a lost response must
    // neither append a duplicate nor resurrect removed reporting.
    const receipts = (draft as PublicationDraft & {
      original_story_creations?: Record<string, { principal_id: string; request_hash: string }>;
    }).original_story_creations;
    const receipt = receipts?.[story.id];
    if (receipt) {
      if (receipt.principal_id !== principal.id || receipt.request_hash !== requestHash
        || expectedRevision > draft.revision
        || !draft.presentation.stories.some((entry) => entry.id === story.id && entry.origin === "original")) {
        throw new PublicationDraftConflict();
      }
      return draft;
    }
    if (draft.revision !== expectedRevision || draft.presentation.stories.some((entry) => entry.id === story.id)) {
      throw new PublicationDraftConflict();
    }
    return updateDraft(db, context, draft, principal, {
      $set: { [`original_story_creations.${story.id}`]: { principal_id: principal.id, request_hash: requestHash } },
      $push: {
        "presentation.stories": story,
        "presentation.story_order": story.id,
      },
    });
  }
  if (draft.revision !== expectedRevision) throw new PublicationDraftConflict();
  if (operation.type === "reopen_for_editing") {
    if (!["ready_for_approval", "approved"].includes(draft.editorial_status)) {
      throw new PublicationDraftValidationError("Only a draft awaiting approval or an approved draft can be reopened.");
    }
    const current = now();
    const reopened = await drafts(db).findOneAndUpdate(
      publicationScopedFilter(context, {
        _id: draft._id,
        revision: draft.revision,
        editorial_status: draft.editorial_status,
      }),
      {
        $set: {
          editorial_status: "editing",
          updated_at: current,
          updated_by: actor(principal),
          ready_for_approval_at: null,
          ready_for_approval_by: null,
        },
        $unset: { approval: "", publish_claim: "" },
        $inc: { revision: 1 },
      },
      { returnDocument: "after" },
    );
    if (!reopened) throw new PublicationDraftConflict();
    return reopened;
  }
  ensureEditing(draft);

  if (operation.type === "inclusion") {
    const storyId = identifier(operation.storyId, "Story");
    const { story, index } = storyAt(draft, storyId);
    if (typeof operation.included !== "boolean") throw new PublicationDraftValidationError("Choose whether to include this story.");
    const generated = generatedPublicationStory(draft, story);
    let resolution = story.hold_resolution;
    if (operation.included && generated?.review.status === "held") {
      if (!publicationHoldIsReviewable(generated)) {
        throw new PublicationDraftValidationError("Hard or unclassified safety holds cannot be overridden.");
      }
      resolution = {
        reason: text(operation.reason, "Hold resolution reason", 1000),
        at: now(), by: actor(principal), flags: [...generated.review.flags],
      };
    }
    const next = { ...story, included: operation.included, ...(resolution ? { hold_resolution: resolution } : {}) };
    const safetyError = operation.included && publicationStorySafetyError(draft, next);
    if (safetyError) throw new PublicationDraftValidationError(safetyError);
    return publicationChangeTransaction(db, async (session) => {
      const updated = await updateDraft(db, context, draft, principal, {
        $set: { [`presentation.stories.${index}`]: next },
      }, session);
      await appendPublicationChangeAudit(db, {
        publication_id: context.id, principal_id: principal.id, principal_email: principal.email,
        action: "story_inclusion_changed", resource_id: `${draftId}:${storyId}`,
        detail: `${operation.included ? "Included" : "Excluded"} ${storyId}${resolution ? `: ${resolution.reason}` : ""}`.slice(0, 500),
        before_hash: null, after_hash: null,
      }, session);
      return updated;
    });
  }
  if (operation.type === "draft") {
    const values: Record<string, unknown> = {};
    if ("headline" in operation) values["presentation.headline"] = text(operation.headline, "Publication headline", 240, false);
    if ("intro" in operation) values["presentation.intro"] = text(operation.intro, "Publication introduction", 4000, false);
    if (!Object.keys(values).length) throw new PublicationDraftValidationError("No draft fields were supplied.");
    return updateDraft(db, context, draft, principal, { $set: values });
  }
  if (operation.type === "bee_game") {
    let game: BeePuzzle | null;
    try { game = operation.game === null ? null : parseBeePuzzle(operation.game); }
    catch (error) {
      throw new PublicationDraftValidationError(error instanceof Error ? error.message : String(error));
    }
    return updateDraft(db, context, draft, principal, { $set: { "presentation.save_the_bee": game } });
  }
  if (operation.type === "section") {
    const sectionId = identifier(operation.sectionId, "Section");
    const index = draft.presentation.sections.findIndex((section) => section.id === sectionId);
    if (index < 0) throw new PublicationDraftValidationError("Section was not found.");
    return updateDraft(db, context, draft, principal, {
      $set: { [`presentation.sections.${index}.title`]: text(operation.title, "Section title", 120, false) },
    });
  }
  if (operation.type === "section_order") {
    const order = validateOrder(operation.sectionIds, draft.presentation.sections.map((section) => section.id), "Section order");
    return updateDraft(db, context, draft, principal, { $set: { "presentation.section_order": order } });
  }
  if (operation.type === "story_order") {
    const order = validateOrder(operation.storyIds, draft.presentation.stories.map((story) => story.id), "Story order");
    return updateDraft(db, context, draft, principal, { $set: { "presentation.story_order": order } });
  }
  if (operation.type === "remove_original_story") {
    const storyId = identifier(operation.storyId, "Story");
    const { story } = storyAt(draft, storyId);
    if (story.origin !== "original") throw new PublicationDraftValidationError("Generated stories cannot be removed from their provenance record.");
    return editorialTransaction(db, async (session) => {
      const updated = await updateDraft(db, context, draft, principal, {
        $pull: {
          "presentation.stories": { id: storyId },
          "presentation.story_order": storyId,
        },
      }, session);
      await notes(db).deleteMany(publicationScopedFilter(context, {
        draft_id: draftId,
        story_id: storyId,
      }), { session });
      const current = now();
      await images(db).updateMany(publicationScopedFilter(context, {
        draft_id: draftId,
        story_id: storyId,
        removed_at: null,
      }), {
        $set: { removed_at: current, removed_by: actor(principal), updated_at: current },
      }, { session });
      return updated;
    });
  }
  if (operation.type === "story") {
    const storyId = identifier(operation.storyId, "Story");
    const { story, index } = storyAt(draft, storyId);
    const values: Record<string, unknown> = {};
    if ("headline" in operation) values[`presentation.stories.${index}.headline`] = text(operation.headline, "Story headline", 240, false, story.origin === "original");
    if ("body" in operation) values[`presentation.stories.${index}.body`] = text(operation.body, "Story body", 20_000, false, story.origin === "original");
    if ("byline" in operation) values[`presentation.stories.${index}.byline`] = text(operation.byline, "Story byline", 240, false, story.origin === "original");
    if ("sectionId" in operation) {
      const sectionId = storySection(draft, operation.sectionId, story.origin === "original");
      values[`presentation.stories.${index}.section_id`] = sectionId;
    }
    if ("locationTags" in operation) {
      values[`presentation.stories.${index}.location_tags`] = validateLocationTags(draft, operation.locationTags, false);
    }
    if ("sourceMetadata" in operation) {
      if (story.origin !== "original") {
        throw new PublicationDraftValidationError("Generated source provenance is immutable.");
      }
      values[`presentation.stories.${index}.source_metadata`] = normalizeSources(operation.sourceMetadata, false);
    }
    if ("imageId" in operation) {
      const imageId = operation.imageId === null ? null : identifier(operation.imageId, "Publication image");
      values[`presentation.stories.${index}.image_id`] = await validateImageReference(db, context, draft, storyId, imageId);
      values[`presentation.stories.${index}.image_review`] = imageId
        ? { status: "ready", reason: "Reviewed image attached." }
        : { status: "removed", reason: "Image removed by an editor." };
    }
    if (!Object.keys(values).length) throw new PublicationDraftValidationError("No story fields were supplied.");
    return updateDraft(db, context, draft, principal, { $set: values });
  }
  if (operation.type === "ready_for_approval") {
    const draftImages = await eligiblePublicationImages(db,
      await images(db).find(publicationScopedFilter(context, { draft_id: draft._id, removed_at: null })).toArray());
    const errors = publicationDraftReadinessErrors(draft, draftImages);
    if (errors.length) throw new PublicationDraftValidationError(errors.join(" "));
    const current = now();
    return updateDraft(db, context, draft, principal, {
      $set: {
        editorial_status: "ready_for_approval",
        ready_for_approval_at: current,
        ready_for_approval_by: actor(principal),
      },
    });
  }
  throw new PublicationDraftValidationError("Draft operation is invalid.");
}

export async function publicationEditorialWorkspace(db: Db, context: PublicationContext, draftId: string) {
  const draft = await editorialDraft(db, context, draftId);
  if (!draft) return null;
  const references = [...new Set(draft.stories.flatMap((story) =>
    story.references.flatMap((reference) => reference.collected_item_ids)))];
  const itemRows = references.length
    ? await collectedItems(db).find(
      { _id: { $in: references } },
      { projection: { _id: 1, title: 1, source_name: 1, url: 1, evidence: 1 } },
    ).toArray()
    : [];
  const itemById = new Map(itemRows.map((item) => [item._id, item]));
  const evidence: PublicationStoryEvidence[] = draft.stories.map((story) => ({
    story_id: story.id,
    review: story.review,
    sources: story.snapshot.sources,
    items: story.references.flatMap((reference) => reference.collected_item_ids)
      .map((id) => itemById.get(id))
      .filter((item): item is CollectedItem => Boolean(item))
      .map((item) => ({
        id: item._id,
        title: item.title,
        source_name: item.source_name,
        url: item.url,
        ...(item.evidence ? { evidence: item.evidence } : {}),
      })),
  }));
  const draftImages = await eligiblePublicationImages(db,
    await images(db).find(publicationScopedFilter(context, {
      draft_id: draft._id,
      removed_at: null,
    })).sort({ created_at: 1, _id: 1 }).toArray());
  return {
    draft: publicationMediaReview(draft, draftImages),
    evidence,
    images: draftImages,
  };
}

export async function createPublicationDraftImage(
  db: Db,
  context: PublicationContext,
  draftId: string,
  storyId: string,
  expectedRevision: number,
  value: unknown,
  principal: Pick<Principal, "id" | "email">,
) {
  await assertPublicationWrite(db, context, "create_publication_image");
  revision(expectedRevision);
  const draft = await editorialDraft(db, context, draftId);
  if (!draft) throw new PublicationDraftNotFound();
  ensureEditing(draft);
  if (draft.revision !== expectedRevision) throw new PublicationDraftConflict();
  const { index } = storyAt(draft, storyId);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicationDraftValidationError("Publication image is invalid.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.authority !== true || raw.people_permissions !== true) {
    throw new PublicationDraftValidationError("Confirm image authority and permissions for depicted people.");
  }
  let granted: ReturnType<typeof validateGrantedPhoto>;
  try {
    granted = validateGrantedPhoto(raw, { requireAlt: true });
  } catch (error) {
    throw new PublicationDraftValidationError(error instanceof Error ? error.message : String(error));
  }
  const current = now();
  const image = publicationOwnedDocument(context, {
    _id: randomUUID(),
    draft_id: draftId,
    story_id: storyId,
    image: granted.image,
    permission: granted.permission,
    authority_confirmed: true as const,
    people_permissions_confirmed: true as const,
    created_at: current,
    created_by: actor(principal),
    updated_at: current,
    removed_at: null,
    removed_by: null,
  });
  return editorialTransaction(db, async (session) => {
    await images(db).insertOne(image, { session });
    const updated = await updateDraft(db, context, draft, principal, {
      $set: {
        [`presentation.stories.${index}.image_id`]: image._id,
        [`presentation.stories.${index}.image_review`]: { status: "ready", reason: "Rights-cleared editorial image attached." },
      },
    }, session);
    return { draft: updated, image };
  });
}

export async function removePublicationDraftImage(
  db: Db,
  context: PublicationContext,
  draftId: string,
  imageId: string,
  expectedRevision: number,
  principal: Pick<Principal, "id" | "email">,
) {
  await assertPublicationWrite(db, context, "remove_publication_image");
  revision(expectedRevision);
  const draft = await editorialDraft(db, context, draftId);
  if (!draft) throw new PublicationDraftNotFound();
  ensureEditing(draft);
  if (draft.revision !== expectedRevision) throw new PublicationDraftConflict();
  const image = await images(db).findOne(publicationScopedFilter(context, {
    _id: imageId,
    draft_id: draftId,
    removed_at: null,
  }));
  if (!image) throw new PublicationDraftValidationError("Publication image was not found.");
  const { story, index } = storyAt(draft, image.story_id);
  if (story.image_id !== imageId) throw new PublicationDraftValidationError("Publication image is not attached to its story.");
  const current = now();
  return editorialTransaction(db, async (session) => {
    const removed = await images(db).findOneAndUpdate(publicationScopedFilter(context, {
      _id: imageId,
      draft_id: draftId,
      story_id: story.id,
      removed_at: null,
    }), {
      $set: { removed_at: current, removed_by: actor(principal), updated_at: current },
    }, { returnDocument: "before", session });
    if (!removed) throw new PublicationDraftValidationError("Publication image was not found.");
    return await updateDraft(db, context, draft, principal, {
      $set: {
        [`presentation.stories.${index}.image_id`]: null,
        [`presentation.stories.${index}.image_review`]: { status: "removed", reason: "Image removed by an editor." },
      },
    }, session);
  });
}

async function noteDraft(db: Db, context: PublicationContext, draftId: string, storyId: string) {
  const draft = await editorialDraft(db, context, draftId);
  if (!draft) throw new PublicationDraftNotFound();
  storyAt(draft, storyId);
  return draft;
}

async function editableNoteDraft(
  db: Db,
  context: PublicationContext,
  draftId: string,
  storyId: string,
  expectedDraftRevision: number,
  session: ClientSession,
) {
  revision(expectedDraftRevision);
  const draft = await drafts(db).findOne(publicationScopedFilter(context, {
    _id: draftId,
    revision: expectedDraftRevision,
    editorial_status: "editing",
  }), { session });
  if (!draft) {
    const exists = await drafts(db).findOne(publicationScopedFilter(context, { _id: draftId }), {
      projection: { _id: 1 },
      session,
    });
    if (!exists) throw new PublicationDraftNotFound();
    throw new PublicationDraftConflict();
  }
  storyAt(draft, storyId);
  return draft;
}

export async function listPublicationInterviewNotes(
  db: Db,
  context: PublicationContext,
  draftId: string,
  storyId: string,
) {
  await noteDraft(db, context, draftId, storyId);
  return notes(db).find(publicationScopedFilter(context, {
    draft_id: draftId,
    story_id: storyId,
  })).sort({ updated_at: -1, _id: -1 }).toArray();
}

export async function createPublicationInterviewNote(
  db: Db,
  context: PublicationContext,
  draftId: string,
  storyId: string,
  expectedDraftRevision: number,
  value: unknown,
  principal: Pick<Principal, "id" | "email">,
) {
  await assertPublicationWrite(db, context, "create_interview_note");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicationDraftValidationError("Interview note is invalid.");
  }
  const raw = value as Record<string, unknown>;
  const current = now();
  const note = publicationOwnedDocument(context, {
    _id: randomUUID(),
    draft_id: draftId,
    story_id: storyId,
    revision: 0,
    interviewee: text(raw.interviewee, "Interviewee", 240),
    interviewed_at: calendarDate(raw.interviewedAt, "Interview date"),
    body: text(raw.body, "Interview note", 20_000),
    created_at: current,
    created_by: actor(principal),
    updated_at: current,
    updated_by: actor(principal),
  });
  return editorialTransaction(db, async (session) => {
    const draft = await editableNoteDraft(db, context, draftId, storyId, expectedDraftRevision, session);
    const updatedDraft = await updateDraft(db, context, draft, principal, {}, session);
    await notes(db).insertOne(note, { session });
    return { note, draft: updatedDraft };
  });
}

export async function updatePublicationInterviewNote(
  db: Db,
  context: PublicationContext,
  draftId: string,
  storyId: string,
  noteId: string,
  expectedDraftRevision: number,
  expectedNoteRevision: number,
  value: unknown,
  principal: Pick<Principal, "id" | "email">,
) {
  await assertPublicationWrite(db, context, "update_interview_note");
  revision(expectedNoteRevision);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicationDraftValidationError("Interview note is invalid.");
  }
  const raw = value as Record<string, unknown>;
  const current = now();
  return editorialTransaction(db, async (session) => {
    const draft = await editableNoteDraft(db, context, draftId, storyId, expectedDraftRevision, session);
    const updatedDraft = await updateDraft(db, context, draft, principal, {}, session);
    const note = await notes(db).findOneAndUpdate(publicationScopedFilter(context, {
      _id: noteId,
      draft_id: draftId,
      story_id: storyId,
      revision: expectedNoteRevision,
    }), {
      $set: {
        interviewee: text(raw.interviewee, "Interviewee", 240),
        interviewed_at: calendarDate(raw.interviewedAt, "Interview date"),
        body: text(raw.body, "Interview note", 20_000),
        updated_at: current,
        updated_by: actor(principal),
      },
      $inc: { revision: 1 },
    }, { returnDocument: "after", session });
    if (!note) throw new PublicationDraftConflict();
    return { note, draft: updatedDraft };
  });
}

export async function deletePublicationInterviewNote(
  db: Db,
  context: PublicationContext,
  draftId: string,
  storyId: string,
  noteId: string,
  expectedDraftRevision: number,
  expectedNoteRevision: number,
  principal: Pick<Principal, "id" | "email">,
) {
  await assertPublicationWrite(db, context, "delete_interview_note");
  revision(expectedNoteRevision);
  return editorialTransaction(db, async (session) => {
    const draft = await editableNoteDraft(db, context, draftId, storyId, expectedDraftRevision, session);
    const updatedDraft = await updateDraft(db, context, draft, principal, {}, session);
    const result = await notes(db).deleteOne(publicationScopedFilter(context, {
      _id: noteId,
      draft_id: draftId,
      story_id: storyId,
      revision: expectedNoteRevision,
    }), { session });
    if (!result.deletedCount) throw new PublicationDraftConflict();
    return { deleted: true, draft: updatedDraft };
  });
}

export function publicationDraftModelInput(draft: PublicationDraft) {
  return {
    publication_id: draft.publication_id,
    generation_id: draft.generation_id,
    window: [...draft.window] as [string, string],
    locations: draft.locations.map((location) => ({ ...location })),
    presentation: structuredClone(draft.presentation),
  };
}

export function publicationDraftPreview(draft: PublicationDraft, draftImages: PublicationDraftImage[]) {
  const imageById = new Map(draftImages.filter((image) => image.removed_at === null).map((image) => [image._id, image.image]));
  const selected = includedPublicationStories(draft);
  const storyById = new Map(selected.map((story) => [story.id, story]));
  return {
    id: draft._id,
    publication_id: draft.publication_id,
    status: draft.editorial_status,
    headline: draft.presentation.headline,
    intro: draft.presentation.intro,
    sections: draft.presentation.section_order.filter((id) => selected.some((story) => story.section_id === id)).map((sectionId) => {
      const section = draft.presentation.sections.find((candidate) => candidate.id === sectionId)!;
      return {
        id: section.id,
        title: section.title,
        stories: draft.presentation.story_order
          .map((storyId) => storyById.get(storyId)!)
          .filter((story) => story && story.section_id === sectionId)
          .map((story) => ({
            id: story.id,
            headline: story.headline,
            body: story.body,
            byline: story.byline,
            location_tags: [...story.location_tags],
            sources: story.source_metadata.map((source) => ({
              type: source.type,
              name: source.name,
              url: source.url,
            })),
            image: story.image_id ? imageById.get(story.image_id) ?? null : null,
          })),
      };
    }),
  };
}
