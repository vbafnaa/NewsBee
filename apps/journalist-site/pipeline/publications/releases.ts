import { createHash, randomUUID } from "node:crypto";
import { parseBeePuzzle } from "../../../../shared/save-the-bee";
import type { Db } from "mongodb";
import {
  PUBLICATION_RELEASE_SCHEMA_VERSION,
  parsePublicationRelease,
  publicationContentHash,
  type PublicationActor,
  type PublicationDraftSnapshotV1,
  type PublicationManifestV1,
  type PublicationReleaseItem,
  type PublicationReleaseManifestEntry,
  type PublicationReleasePayloadV1,
} from "../../../../shared/publication-release";
import type { Principal } from "../accounts/identity";
import {
  channelArtifactStore,
} from "../storage/mongo-channel-artifacts";
import type { ArtifactStore } from "../storage/artifacts";
import { COLLECTIONS } from "../storage/mongo";
import type { OutputChannelDocument } from "../orchestration/output-channels";
import {
  assertPublicationWrite,
  authorizedPublicationFilter,
  ensurePublicationIndexes,
  publicationOwnedDocument,
  publicationScopedFilter,
  type PublicationContext,
} from "./access";
import {
  appendPublicationChangeAudit,
  publicationChangeTransaction,
} from "./audit";
import { migratePublicationDraftInclusion, publicationDraftReadinessErrors, type PublicationDraftImage } from "./editorial";
import { includedPublicationStories, publicationSelectionErrors, publicationStoryIncluded } from "./inclusion";
import { cloneCorrectionImages, eligiblePublicationImages, publicationImageReleaseFields } from "./media";
import type { PublicationDraft, PublicationPresentationStory } from "./generation";
import {
  enabledSponsorPlacements,
  resolvePublicationSettings,
} from "./settings";

export class PublicationReleaseConflict extends Error {}
export class PublicationReleaseNotFound extends Error {}
export class PublicationReleaseValidationError extends Error {}

export type PublicationReleaseAction = {
  _id: string;
  publication_id: string;
  release_id: string;
  action: "withdraw" | "restore" | "source_withdrawal" | "source_restore";
  reason: string;
  at: number;
  by: PublicationActor;
  source?: {
    location_id: string;
    story_id: string;
  };
};

const now = () => Date.now() / 1000;
const actor = (principal: Pick<Principal, "id" | "email">): PublicationActor => ({
  id: principal.id,
  email: principal.email,
});
const drafts = (db: Db) => db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts);
const images = (db: Db) => db.collection<PublicationDraftImage>(COLLECTIONS.publicationImages);
const actions = (db: Db) => db.collection<PublicationReleaseAction>(COLLECTIONS.publicationReleaseActions);
const MANIFEST_CLAIM_SECONDS = 60;
const MANIFEST_LOCK_ATTEMPTS = 40;

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function reasonText(value: unknown, label: string) {
  if (typeof value !== "string") throw new PublicationReleaseValidationError(`${label} is required.`);
  const reason = value.replace(/\s+/g, " ").trim();
  if (!reason || reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new PublicationReleaseValidationError(`${label} must be between 1 and 1000 characters.`);
  }
  return reason;
}

function storySource(
  draft: PublicationDraft,
  story: PublicationPresentationStory,
) {
  return story.generated_story_id
    ? draft.stories.find((candidate) => candidate.id === story.generated_story_id)
    : undefined;
}

export async function publicationDraftSnapshot(
  db: Db,
  context: PublicationContext,
  draft: PublicationDraft,
  options: { requireComplete?: boolean } = {},
): Promise<PublicationDraftSnapshotV1> {
  const draftImages = await eligiblePublicationImages(db, await images(db).find(publicationScopedFilter(context, {
    draft_id: draft._id,
    removed_at: null,
  })).toArray());
  const errors = options.requireComplete
    ? publicationDraftReadinessErrors(draft, draftImages)
    : publicationSelectionErrors(draft);
  if (errors.length) throw new PublicationReleaseValidationError(errors.join(" "));
  let game: ReturnType<typeof parseBeePuzzle> | undefined;
  try { game = draft.presentation.save_the_bee != null ? parseBeePuzzle(draft.presentation.save_the_bee) : undefined; }
  catch (error) {
    throw new PublicationReleaseValidationError(error instanceof Error ? error.message : String(error));
  }
  const imageById = new Map(draftImages.map((image) => [image._id, image]));
  const locationById = new Map(draft.locations.map((location) => [location.id, location]));
  const included = includedPublicationStories(draft);
  const sectionById = new Map(draft.presentation.sections.map((section) => [section.id, section]));
  const items = included.map((story, index): PublicationReleaseItem => {
    const section = sectionById.get(story.section_id);
    if (!section) throw new PublicationReleaseValidationError("Draft story section is invalid.");
    const generated = storySource(draft, story);
    const selectedLocations = story.location_tags.map((id) => locationById.get(id));
    if (selectedLocations.some((location) => !location)) {
      throw new PublicationReleaseValidationError("Draft story locations are invalid.");
    }
    const sources = story.source_metadata.map(({ name, url }) => ({ name, url }));
    const selectedImage = story.image_id ? imageById.get(story.image_id) : null;
    if (story.image_id && (!selectedImage || selectedImage.story_id !== story.id)) {
      throw new PublicationReleaseValidationError("The attached publication image or its current rights are unavailable. Replace or remove it.");
    }
    const image = selectedImage ? publicationImageReleaseFields(selectedImage) : undefined;
    return {
      ...(image ?? {}),
      item_id: story.id,
      story_id: story.id,
      origin: story.origin,
      source_references: generated?.references.map((reference) => ({
        location_id: reference.location_id,
        edition_id: reference.draft_id,
        story_id: reference.story_id,
      })) ?? [],
      location_ids: selectedLocations.map((location) => location!.id),
      location_names: selectedLocations.map((location) => location!.name),
      section_id: section.id,
      section_title: section.title,
      headline: story.headline,
      blurb: story.body,
      byline: story.byline,
      when_where: generated?.snapshot.when_where ?? "",
      event_date: generated?.snapshot.event_date ?? draft.window[0],
      source_url: sources.find((source) => source.url)?.url ?? null,
      sources,
      rank: index + 1,
      kind: generated?.snapshot.kind || "local_news",
    };
  });
  return {
    schema_version: PUBLICATION_RELEASE_SCHEMA_VERSION,
    draft_id: draft._id,
    draft_revision: draft.revision,
    title: draft.presentation.headline,
    intro: draft.presentation.intro,
    ...(game ? { save_the_bee: game } : {}),
    window_start: draft.window[0],
    window_end: draft.window[1],
    locations: draft.locations.map(({ id, name }) => ({ id, name })),
    sections: draft.presentation.section_order.filter((id) => included.some((story) => story.section_id === id)).map((id) => {
      const section = sectionById.get(id);
      if (!section) throw new PublicationReleaseValidationError("Draft section order is invalid.");
      return { id: section.id, title: section.title };
    }),
    items,
    correction: draft.correction ? {
      supersedes_release_id: draft.correction.supersedes_release_id,
      reason: draft.correction.reason,
    } : null,
  };
}

export async function approvePublicationDraft(
  db: Db,
  context: PublicationContext,
  draftId: string,
  expectedRevision: number,
  principal: Principal,
) {
  await assertPublicationWrite(db, context, "approve_publication_draft");
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new PublicationReleaseValidationError("Draft revision is invalid.");
  }
  const loaded = await drafts(db).findOne(publicationScopedFilter(context, { _id: draftId }));
  if (!loaded) throw new PublicationReleaseNotFound();
  const draft = await migratePublicationDraftInclusion(db, context, loaded);
  if (draft.revision !== expectedRevision || draft.editorial_status !== "ready_for_approval") {
    throw new PublicationReleaseConflict("The draft changed or is not ready for approval.");
  }
  const snapshot = await publicationDraftSnapshot(db, context, draft, { requireComplete: true });
  const contentHash = publicationContentHash(snapshot);
  const approvedAt = now();
  const approvedBy = actor(principal);
  return publicationChangeTransaction(db, async (session) => {
    const approved = await drafts(db).findOneAndUpdate(
      publicationScopedFilter(context, {
        _id: draftId,
        revision: expectedRevision,
        editorial_status: "ready_for_approval",
      }),
      {
        $set: {
          editorial_status: "approved",
          approval: {
            revision: expectedRevision,
            content_hash: contentHash,
            approved_by: approvedBy,
            approved_at: approvedAt,
            snapshot,
          },
          updated_at: approvedAt,
          updated_by: approvedBy,
        },
      },
      { returnDocument: "after", session },
    );
    if (!approved) throw new PublicationReleaseConflict("The draft changed before approval.");
    await appendPublicationChangeAudit(db, {
      publication_id: context.id,
      principal_id: principal.id,
      principal_email: principal.email,
      action: "release_approved",
      resource_id: draftId,
      detail: `Approved draft revision ${expectedRevision}`,
      before_hash: null,
      after_hash: contentHash,
    }, session);
    return approved;
  });
}

function hasReaderDestination(publication: OutputChannelDocument) {
  const destinations = publication.destinations?.length
    ? publication.destinations
    : [{ type: publication.destination ?? "reader", url: publication.url ?? "" }];
  return destinations.some((destination) => destination.type === "reader");
}

function releasePayload(
  draft: PublicationDraft,
  publication: OutputChannelDocument,
  principal: Principal,
  releaseId: string,
  publishedAt: number,
): PublicationReleasePayloadV1 {
  if (!draft.approval) throw new PublicationReleaseConflict("Approve the exact draft revision before publishing.");
  const settings = resolvePublicationSettings(publication);
  const payload: PublicationReleasePayloadV1 = {
    ...draft.approval.snapshot,
    release_id: releaseId,
    publication: {
      id: publication._id,
      profile_revision: settings.profile.revision,
      display_name: settings.profile.values.display_name,
      description: settings.profile.values.description,
      homepage_url: settings.profile.values.homepage_url,
      logo_url: settings.profile.values.logo_url,
    },
    sponsor_placements: {
      revision: settings.sponsor_placements.revision,
      placements: enabledSponsorPlacements(settings),
    },
    approval: {
      draft_revision: draft.approval.revision,
      draft_content_hash: draft.approval.content_hash,
      approved_by: draft.approval.approved_by,
      approved_at: draft.approval.approved_at,
    },
    published_by: actor(principal),
    published_at: publishedAt,
  };
  if (!parsePublicationRelease(payload)) {
    throw new PublicationReleaseValidationError("The approved content does not satisfy the Reader release contract. Reopen and correct the draft.");
  }
  return payload;
}

async function effectiveActions(db: Db, context: PublicationContext) {
  const rows = await actions(db).find(publicationScopedFilter(context, {
    action: { $in: ["withdraw", "restore"] },
  }))
    .sort({ at: 1, _id: 1 }).toArray();
  return new Map(rows.map((row) => [row.release_id, row]));
}

async function effectiveSourceActions(db: Db, context: PublicationContext, releaseIds: string[]) {
  if (!releaseIds.length) return new Map<string, PublicationReleaseAction[]>();
  const rows = await actions(db).find(publicationScopedFilter(context, {
    release_id: { $in: releaseIds },
    action: { $in: ["source_withdrawal", "source_restore"] },
  })).sort({ at: 1, _id: 1 }).toArray();
  const latest = new Map<string, PublicationReleaseAction>();
  for (const row of rows) {
    if (!row.source) continue;
    latest.set(`${row.release_id}\u0000${row.source.location_id}\u0000${row.source.story_id}`, row);
  }
  const byRelease = new Map<string, PublicationReleaseAction[]>();
  for (const row of latest.values()) {
    const values = byRelease.get(row.release_id) ?? [];
    values.push(row);
    byRelease.set(row.release_id, values);
  }
  for (const values of byRelease.values()) {
    values.sort((left, right) => left.at - right.at || left._id.localeCompare(right._id));
  }
  return byRelease;
}

async function releaseRows(
  db: Db,
  context: PublicationContext,
) {
  const published = await drafts(db).find(publicationScopedFilter(context, {
    editorial_status: "published",
    "release.release_id": { $type: "string" },
  })).sort({ "release.published_at": -1, _id: -1 }).toArray();
  const releases = published.flatMap((draft) => draft.release ? [{
    draft_id: draft._id,
    release_id: draft.release.release_id,
    payload: draft.release.payload,
    content_hash: draft.release.content_hash,
    artifact_file_id: draft.release.artifact_file_id,
  }] : []);
  return releases.sort((left, right) =>
    right.payload.published_at - left.payload.published_at || right.release_id.localeCompare(left.release_id));
}

function manifestPointer(
  manifest: PublicationManifestV1,
  manifestFileId: string,
  releases: Awaited<ReturnType<typeof releaseRows>>,
) {
  const latest = manifest.latest;
  const latestRelease = latest
    ? releases.find((release) => release.release_id === latest.release_id)
    : undefined;
  return {
    manifest_file_id: manifestFileId,
    manifest_revision: manifest.revision,
    latest_release_id: latest?.release_id ?? null,
    latest_published_at: latest?.published_at ?? null,
    latest_title: latest?.title ?? null,
    latest_window_start: latest?.window_start ?? null,
    latest_window_end: latest?.window_end ?? null,
    location_ids: latest?.locations.map((location) => location.id) ?? [],
    locations: latest?.locations ?? [],
    publication: latestRelease?.payload.publication ?? null,
  };
}

async function buildManifest(
  db: Db,
  context: PublicationContext<OutputChannelDocument>,
  revision: number,
) {
  const releases = await releaseRows(db, context);
  const actionByRelease = await effectiveActions(db, context);
  const archive: PublicationReleaseManifestEntry[] = releases.map((release) => {
    const action = actionByRelease.get(release.release_id);
    const withdrawn = action?.action === "withdraw";
    return {
      release_id: release.release_id,
      title: release.payload.title,
      window_start: release.payload.window_start,
      window_end: release.payload.window_end,
      published_at: release.payload.published_at,
      content_hash: release.content_hash,
      artifact_file_id: release.artifact_file_id,
      locations: release.payload.locations,
      supersedes_release_id: release.payload.correction?.supersedes_release_id ?? null,
      withdrawn,
      withdrawal_reason: withdrawn ? action.reason : null,
    };
  });
  const latest = archive.find((entry) => !entry.withdrawn) ?? null;
  const latestRelease = latest
    ? releases.find((release) => release.release_id === latest.release_id)
    : undefined;
  const manifest: PublicationManifestV1 = {
    schema_version: PUBLICATION_RELEASE_SCHEMA_VERSION,
    publication: latestRelease?.payload.publication ?? releases[0]?.payload.publication ?? {
      id: context.id,
      profile_revision: 0,
      display_name: context.publication.name,
      description: null,
      homepage_url: null,
      logo_url: null,
    },
    revision,
    generated_at: now(),
    latest,
    archive,
  };
  return { manifest, releases };
}

function pointerRevisionFilter(revision: number) {
  return revision
    ? { "reader_publication.manifest_revision": revision }
    : {
        $or: [
          { reader_publication: { $exists: false } },
          { "reader_publication.manifest_revision": { $exists: false } },
          { "reader_publication.manifest_revision": 0 },
        ],
      };
}

async function acquireManifestClaim(
  db: Db,
  context: PublicationContext<OutputChannelDocument>,
) {
  for (let attempt = 0; attempt < MANIFEST_LOCK_ATTEMPTS; attempt += 1) {
    const token = randomUUID();
    const claimedAt = now();
    const publication = await db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels).findOneAndUpdate(
      {
        $and: [
          authorizedPublicationFilter(context),
          {
            $or: [
              { reader_manifest_claim: { $exists: false } },
              { "reader_manifest_claim.claimed_at": { $lt: claimedAt - MANIFEST_CLAIM_SECONDS } },
            ],
          },
        ],
      },
      { $set: { reader_manifest_claim: { token, claimed_at: claimedAt } } },
      { returnDocument: "after" },
    );
    if (publication) return { publication, token };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new PublicationReleaseConflict("Another publication update is still finalizing. Retry shortly.");
}

async function rebuildManifestPointer(
  db: Db,
  store: ArtifactStore,
  context: PublicationContext<OutputChannelDocument>,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { publication, token } = await acquireManifestClaim(db, context);
    try {
      const currentRevision = publication.reader_publication?.manifest_revision ?? 0;
      const freshContext = { ...context, publication };
      const { manifest, releases } = await buildManifest(db, freshContext, currentRevision + 1);
      const digest = publicationContentHash(manifest).slice(0, 20);
      const files = channelArtifactStore(db, store, publication.drive_folder_id);
      const manifestFileId = await files.saveJson(
        publication.drive_folder_id,
        `publication-manifest-${manifest.revision}-${digest}.json`,
        manifest,
      );
      const result = await db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels).updateOne(
        {
          $and: [
            authorizedPublicationFilter(context),
            { "reader_manifest_claim.token": token },
            pointerRevisionFilter(currentRevision),
          ],
        },
        {
          $set: { reader_publication: manifestPointer(manifest, manifestFileId, releases) },
          $unset: { reader_manifest_claim: "" },
        },
      );
      if (result.matchedCount) return { manifest, manifestFileId };
    } finally {
      await db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels).updateOne(
        { _id: context.id, "reader_manifest_claim.token": token },
        { $unset: { reader_manifest_claim: "" } },
      );
    }
  }
  throw new PublicationReleaseConflict("The publication manifest changed repeatedly. Retry publication.");
}

async function claimPublication(
  db: Db,
  context: PublicationContext<OutputChannelDocument>,
  draft: PublicationDraft,
  expectedRevision: number,
  expectedContentHash: string,
  principal: Principal,
) {
  if (!draft.approval
    || draft.approval.revision !== expectedRevision
    || draft.approval.content_hash !== expectedContentHash
    || draft.revision !== expectedRevision
    || draft.editorial_status !== "approved"
  ) throw new PublicationReleaseConflict("The approved draft revision or content hash changed.");
  const locationIds = [...new Set(draft.approval.snapshot.locations.map((location) => location.id))];
  const availableLocations = await db.collection<{ _id: string; removal?: unknown }>(COLLECTIONS.locations).countDocuments({
    _id: { $in: locationIds },
    removal: { $exists: false },
  });
  if (availableLocations !== locationIds.length) {
    throw new PublicationReleaseValidationError(
      "One or more approved locations were removed or are being removed. Reopen the draft before publishing.",
    );
  }
  const releaseId = randomUUID().replaceAll("-", "");
  const claimedAt = now();
  const token = randomUUID();
  const payload = releasePayload(draft, context.publication, principal, releaseId, claimedAt);
  const contentHash = publicationContentHash(payload);
  const claimed = await drafts(db).findOneAndUpdate(
    publicationScopedFilter(context, {
      _id: draft._id,
      revision: expectedRevision,
      editorial_status: "approved",
      "approval.revision": expectedRevision,
      "approval.content_hash": expectedContentHash,
    }),
    {
      $set: {
        editorial_status: "publishing",
        publish_claim: {
          token,
          release_id: releaseId,
          payload,
          content_hash: contentHash,
          claimed_at: claimedAt,
          claimed_by: actor(principal),
        },
        updated_at: claimedAt,
        updated_by: actor(principal),
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed?.publish_claim) throw new PublicationReleaseConflict("The draft changed before publication.");
  return claimed;
}

export async function publishPublicationDraft(
  db: Db,
  store: ArtifactStore,
  context: PublicationContext<OutputChannelDocument>,
  draftId: string,
  expectedRevision: number,
  expectedContentHash: string,
  principal: Principal,
) {
  await assertPublicationWrite(db, context, "publish_publication_draft");
  await ensurePublicationIndexes(db);
  if (!context.publication.enabled) {
    throw new PublicationReleaseValidationError("Enable this publication before publishing.");
  }
  if (!hasReaderDestination(context.publication)) {
    throw new PublicationReleaseValidationError("This publication does not have a Reader destination.");
  }
  let draft = await drafts(db).findOne(publicationScopedFilter(context, { _id: draftId }));
  if (!draft) throw new PublicationReleaseNotFound();
  if (draft.editorial_status !== "published") {
    draft = await migratePublicationDraftInclusion(db, context, draft);
    if (draft.revision !== expectedRevision) throw new PublicationReleaseConflict("Draft inclusion changed. Review and approve the current revision.");
    const snapshot = await publicationDraftSnapshot(db, context, draft, { requireComplete: true });
    if (!draft.approval || publicationContentHash(snapshot) !== draft.approval.content_hash) {
      throw new PublicationReleaseConflict("The included content or safety eligibility changed. Reopen and approve this draft again.");
    }
  }
  if (draft.editorial_status === "published" && draft.release
    && draft.approval?.revision === expectedRevision
    && draft.approval.content_hash === expectedContentHash) {
    const publication = await db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels)
      .findOne(authorizedPublicationFilter(context));
    if (draft.release.manifest_file_id
      && draft.release.manifest_revision
      && publication?.reader_publication?.manifest_file_id === draft.release.manifest_file_id
      && publication.reader_publication.manifest_revision === draft.release.manifest_revision) {
      return draft;
    }
    const pointer = await rebuildManifestPointer(db, store, context);
    await drafts(db).updateOne(publicationScopedFilter(context, {
      _id: draftId,
      "release.release_id": draft.release.release_id,
    }), {
      $set: {
        "release.manifest_file_id": pointer.manifestFileId,
        "release.manifest_revision": pointer.manifest.revision,
      },
    });
    return (await drafts(db).findOne(publicationScopedFilter(context, { _id: draftId })))!;
  }
  if (draft.editorial_status === "approved") {
    draft = await claimPublication(db, context, draft, expectedRevision, expectedContentHash, principal);
  }
  const claim = draft.publish_claim;
  if (draft.editorial_status !== "publishing" || !claim
    || draft.revision !== expectedRevision
    || draft.approval?.content_hash !== expectedContentHash
  ) throw new PublicationReleaseConflict("The release is not available for this publication request.");

  const files = channelArtifactStore(db, store, context.publication.drive_folder_id);
  const artifactFileId = await files.saveJson(
    context.publication.drive_folder_id,
    `publication-release-${claim.release_id}.json`,
    claim.payload,
  );
  const release = {
    release_id: claim.release_id,
    content_hash: claim.content_hash,
    payload: claim.payload,
    artifact_file_id: artifactFileId,
    published_at: claim.payload.published_at,
    published_by: claim.payload.published_by,
  };
  const published = await publicationChangeTransaction(db, async (session) => {
    const published = await drafts(db).findOneAndUpdate(
      publicationScopedFilter(context, {
        _id: draftId,
        editorial_status: "publishing",
        "publish_claim.token": claim.token,
      }),
      {
        $set: {
          editorial_status: "published",
          unpublished: false,
          editable: false,
          distribution: { reader: true, email: false },
          release,
          updated_at: claim.payload.published_at,
          updated_by: claim.payload.published_by,
        },
        $unset: { publish_claim: "" },
      },
      { returnDocument: "after", session },
    );
    if (!published) {
      const existing = await drafts(db).findOne(publicationScopedFilter(context, { _id: draftId }), { session });
      if (existing?.editorial_status === "published" && existing.release?.release_id === claim.release_id) return existing;
      throw new PublicationReleaseConflict("The release changed before publication completed.");
    }
    await appendPublicationChangeAudit(db, {
      publication_id: context.id,
      principal_id: principal.id,
      principal_email: principal.email,
      action: "release_published",
      resource_id: claim.release_id,
      detail: `Published approved draft revision ${expectedRevision}`,
      before_hash: expectedContentHash,
      after_hash: claim.content_hash,
    }, session);
    return published;
  });
  const pointer = await rebuildManifestPointer(db, store, context);
  await drafts(db).updateOne(publicationScopedFilter(context, {
    _id: draftId,
    "release.release_id": claim.release_id,
  }), {
    $set: {
      "release.manifest_file_id": pointer.manifestFileId,
      "release.manifest_revision": pointer.manifest.revision,
    },
  });
  return (await drafts(db).findOne(publicationScopedFilter(context, { _id: published._id }))) ?? published;
}

export async function createPublicationCorrection(
  db: Db,
  context: PublicationContext,
  releaseId: string,
  reasonValue: unknown,
  principal: Principal,
) {
  await assertPublicationWrite(db, context, "create_publication_correction");
  const reason = reasonText(reasonValue, "Correction reason");
  const source = await drafts(db).findOne(publicationScopedFilter(context, {
    editorial_status: "published",
    "release.release_id": releaseId,
  }));
  if (!source?.release) throw new PublicationReleaseNotFound();
  const id = randomUUID();
  const createdAt = now();
  const createdBy = actor(principal);
  const correction: PublicationDraft = {
    ...structuredClone(source),
    inclusion_version: 1,
    presentation: {
      ...structuredClone(source.presentation),
      stories: source.presentation.stories.map((story) => ({ ...structuredClone(story), included: publicationStoryIncluded(source, story) })),
    },
    _id: id,
    ...(source.generation_id ? { generation_id: `${source.generation_id}:correction:${id}` } : {}),
    status: "ready",
    unpublished: true,
    editable: true,
    title: `Correction · ${source.title}`,
    revision: 0,
    editorial_status: "editing",
    updated_at: createdAt,
    updated_by: createdBy,
    ready_for_approval_at: null,
    ready_for_approval_by: null,
    correction: {
      supersedes_release_id: releaseId,
      reason,
      created_at: createdAt,
      created_by: createdBy,
    },
    distribution: { reader: false, email: false },
    created_at: createdAt,
  };
  delete correction.approval;
  delete correction.publish_claim;
  delete correction.release;
  delete correction.manual_creation;
  await publicationChangeTransaction(db, async (session) => {
    await cloneCorrectionImages(db, context, source, correction, session);
    await drafts(db).insertOne(publicationOwnedDocument(context, correction), { session });
    await appendPublicationChangeAudit(db, {
      publication_id: context.id,
      principal_id: principal.id,
      principal_email: principal.email,
      action: "release_correction_created",
      resource_id: id,
      detail: `Created correction successor for ${releaseId}`,
      before_hash: source.release!.content_hash,
      after_hash: hash({ reason, draft_id: id }),
    }, session);
  });
  return correction;
}

export async function changePublicationReleaseAvailability(
  db: Db,
  store: ArtifactStore,
  context: PublicationContext<OutputChannelDocument>,
  releaseId: string,
  action: "withdraw" | "restore",
  reasonValue: unknown,
  principal: Principal,
) {
  await assertPublicationWrite(db, context, `${action}_publication_release`);
  const reason = reasonText(reasonValue, action === "withdraw" ? "Withdrawal reason" : "Restore reason");
  const release = await drafts(db).findOne(publicationScopedFilter(context, {
    editorial_status: "published",
    "release.release_id": releaseId,
  }));
  if (!release?.release) throw new PublicationReleaseNotFound();
  await publicationChangeTransaction(db, async (session) => {
    const latestAction = await actions(db).find(publicationScopedFilter(context, {
      release_id: releaseId,
      action: { $in: ["withdraw", "restore"] },
    }), { session }).sort({ at: -1, _id: -1 }).limit(1).next();
    if (latestAction?.action === action) return;
    await actions(db).insertOne(publicationOwnedDocument(context, {
      _id: randomUUID(),
      release_id: releaseId,
      action,
      reason,
      at: now(),
      by: actor(principal),
    }), { session });
    await appendPublicationChangeAudit(db, {
      publication_id: context.id,
      principal_id: principal.id,
      principal_email: principal.email,
      action: action === "withdraw" ? "release_withdrawn" : "release_restored",
      resource_id: releaseId,
      detail: `${action === "withdraw" ? "Withdrew" : "Restored"} immutable release ${releaseId}`,
      before_hash: hash(latestAction ?? null),
      after_hash: hash({ action, reason }),
    }, session);
  });
  return (await rebuildManifestPointer(db, store, context)).manifest;
}

export async function listPublicationReleases(db: Db, context: PublicationContext) {
  const rows = await releaseRows(db, context);
  const actionByRelease = await effectiveActions(db, context);
  const sourceActions = await effectiveSourceActions(db, context, rows.map((row) => row.release_id));
  return rows.map((row) => ({
    draftId: row.draft_id,
    releaseId: row.release_id,
    title: row.payload.title,
    windowStart: row.payload.window_start,
    windowEnd: row.payload.window_end,
    publishedAt: row.payload.published_at,
    contentHash: row.content_hash,
    locations: row.payload.locations,
    correction: row.payload.correction,
    action: actionByRelease.get(row.release_id) ?? null,
    sourceChanges: (sourceActions.get(row.release_id) ?? []).map((sourceAction) => ({
      action: sourceAction.action,
      reason: sourceAction.reason,
      at: sourceAction.at,
      source: sourceAction.source!,
    })),
    correctionRequired: (sourceActions.get(row.release_id) ?? [])
      .some((sourceAction) => sourceAction.action === "source_withdrawal"),
  }));
}

/** Published stories per release, newest release first, for the journalist Videos list. */
export async function listPublicationReleaseStories(db: Db, context: PublicationContext) {
  const [rows, actionByRelease] = await Promise.all([releaseRows(db, context), effectiveActions(db, context)]);
  return rows.map((row) => ({
    releaseId: row.release_id,
    draftId: row.draft_id,
    title: row.payload.title,
    windowStart: row.payload.window_start,
    windowEnd: row.payload.window_end,
    publishedAt: row.payload.published_at,
    withdrawn: actionByRelease.get(row.release_id)?.action === "withdraw",
    stories: row.payload.items.map((item) => ({ id: item.item_id, headline: item.headline, locations: item.location_names })),
  }));
}

export async function loadPublicationReleaseForDistribution(
  db: Db,
  context: PublicationContext,
  releaseId: string,
) {
  await ensurePublicationIndexes(db);
  const draft = await drafts(db).findOne(publicationScopedFilter(context, {
    editorial_status: "published",
    "release.release_id": releaseId,
  }));
  const stored = draft?.release;
  if (!stored) throw new PublicationReleaseNotFound();
  const payload = parsePublicationRelease(stored.payload);
  if (!payload
    || payload.publication.id !== context.id
    || payload.release_id !== releaseId
    || publicationContentHash(payload) !== stored.content_hash
  ) {
    throw new PublicationReleaseValidationError("The immutable release failed its integrity check.");
  }
  const releaseAction = await actions(db).find(publicationScopedFilter(context, {
    release_id: releaseId,
    action: { $in: ["withdraw", "restore"] },
  })).sort({ at: -1, _id: -1 }).limit(1).next();
  if (releaseAction?.action === "withdraw") {
    throw new PublicationReleaseConflict("Withdrawn releases cannot start new distribution.");
  }
  const sourceActions = await effectiveSourceActions(db, context, [releaseId]);
  if ((sourceActions.get(releaseId) ?? []).some((action) => action.action === "source_withdrawal")) {
    throw new PublicationReleaseConflict("This release has a source withdrawal and requires correction before distribution.");
  }
  return {
    draftId: draft._id,
    releaseId,
    contentHash: stored.content_hash,
    payload,
  };
}

export async function flagPublicationReleasesForSourceChange(
  db: Db,
  locationId: string,
  storyId: string,
  action: "source_withdrawal" | "source_restore",
  reason: string,
  principal: Principal,
) {
  const affected = await drafts(db).find({
    editorial_status: "published",
    "release.payload.items.source_references": {
      $elemMatch: { location_id: locationId, story_id: storyId },
    },
  }, {
    projection: { publication_id: 1, "release.release_id": 1 },
  }).toArray();
  for (const draft of affected) {
    const releaseId = draft.release?.release_id;
    if (!releaseId) continue;
    const latest = await actions(db).find({
      publication_id: draft.publication_id,
      release_id: releaseId,
      "source.location_id": locationId,
      "source.story_id": storyId,
      action: { $in: ["source_withdrawal", "source_restore"] },
    }).sort({ at: -1, _id: -1 }).limit(1).next();
    if (latest?.action === action) continue;
    await actions(db).insertOne({
      _id: randomUUID(),
      publication_id: draft.publication_id,
      release_id: releaseId,
      action,
      reason,
      at: now(),
      by: actor(principal),
      source: { location_id: locationId, story_id: storyId },
    });
  }
  return affected.length;
}
