import { createHash, randomUUID } from "node:crypto";
import type { BeePuzzle } from "../../../../shared/save-the-bee";
import type { Db } from "mongodb";
import { principalById, type Principal } from "../accounts/identity";
import { assertGlobalAdmission, GlobalAdmissionConflict, preparePolicyBinding, resolveExecutionProviderPolicy } from "../accounts/execution";
import { locationReadinessForIds } from "../communities/readiness";
import { listLocations } from "../communities/locations";
import type { RunOptions } from "../core/run-values";
import { resolveRunOptions } from "../core/run-options";
import { WINDOW_DAYS } from "../core/time";
import { logger } from "../core/log";
import { ExecutionBlocked, executionBlock } from "../core/execution-errors";
import { collectedItems } from "../editions/assemble";
import { PLAYBOOK_VERSION } from "../playbook";
import {
  acquireAdmissionLease,
  acquirePublicationGenerationLease,
  activeRunExecutions,
  cancelRunJobs,
  enqueue,
  releaseLease,
  type Job,
} from "../orchestration/jobs";
import { startRun, type OrchestratorDeps } from "../orchestration/orchestrator";
import {
  ACTIVE_RUN_STATUSES,
  RunConflict,
  runs,
  type PipelineRun,
} from "../orchestration/runs";
import { assertPublicationWrite, resolvePrivilegedPublicationContext, resolvePublicationContext, type PublicationContext } from "./access";
import { appendPublicationChangeAudit, publicationChangeTransaction } from "./audit";
import { publicationLifecycleFilter, PublicationLifecycleConflict } from "./lifecycle";
import { hasPublicationCapability } from "./permissions";
import { PublicationAccessDenied } from "./permissions";
import { COLLECTIONS } from "../storage/mongo";
import type { PublicationPreferenceSnapshot } from "../../../../shared/publication-settings";
import type {
  PublicationActor,
  PublicationDraftSnapshotV1,
  PublicationReleasePayloadV1,
} from "../../../../shared/publication-release";
import {
  publicationPreferenceSnapshot,
  resolvePublicationSettings,
  type PublicationSettingsDocument,
} from "./settings";
import { generatedImageSnapshot, generatedPublicationImages, type PublicationDraftImage, type PublicationImageReview } from "./media";
import { includedPublicationStories, publicationReviewHolds, type PublicationReviewHold, type PublicationHoldResolution } from "./inclusion";
import { ACTIVE_PUBLICATION_GENERATION_STATUSES, ensurePublicationGenerationAdmissionIndex, type PublicationGenerationStatus } from "./generation-status";
import { MaintenanceError, assertSiteOpen, withSiteWriter } from "../../../../shared/restore-maintenance";

export const MAX_PUBLICATION_GENERATION_LOCATIONS = 8;
export { ACTIVE_PUBLICATION_GENERATION_STATUSES } from "./generation-status";
export type { PublicationGenerationStatus } from "./generation-status";

type GenerationLocation = {
  id: string;
  name: string;
  source_map_version: number | null;
};

export type PublicationGeneration = {
  _id: string;
  admission: "newsroom";
  publication_id: string;
  publication_name: string;
  owner_id: string;
  initiated_by: string;
  initiated_by_email: string;
  idempotency_key: string;
  status: PublicationGenerationStatus;
  window: [string, string];
  today: string;
  locations: GenerationLocation[];
  child_run_ids: string[];
  options: RunOptions;
  publication_version: string;
  preference_version: string;
  preference_snapshot: PublicationPreferenceSnapshot;
  config_version: string;
  managed_execution: boolean;
  progress: {
    total: number;
    completed: number;
    failed: number;
  };
  draft_id: string | null;
  error: string | null;
  execution_blocked?: ReturnType<typeof executionBlock>;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

export type DraftSource = { name: string; url: string | null };
export type PublicationDraftStory = {
  id: string;
  canonical_identity: string;
  location_tags: Array<{ id: string; name: string }>;
  references: Array<{
    run_id: string;
    draft_id: string;
    entry_id: string;
    story_id: string;
    location_id: string;
    collected_item_ids: string[];
  }>;
  snapshot: {
    headline: string;
    summary: string;
    when_where: string | null;
    event_date: string | null;
    kind: string;
    section: string | null;
    sources: DraftSource[];
    image: Record<string, unknown> | null;
  };
  review: {
    status: "ready" | "held";
    flags: string[];
    holds?: PublicationReviewHold[];
  };
};

export type PublicationEditorialSource = {
  id: string;
  type: "web" | "document" | "interview" | "observation";
  name: string;
  url: string | null;
  note: string | null;
};

export type PublicationPresentationStory = {
  id: string;
  origin: "generated" | "original";
  generated_story_id: string | null;
  section_id: string;
  headline: string;
  body: string;
  byline: string;
  location_tags: string[];
  source_metadata: PublicationEditorialSource[];
  image_id: string | null;
  image_review?: PublicationImageReview;
  included?: boolean;
  hold_resolution?: PublicationHoldResolution;
};

export type PublicationDraftPresentation = {
  save_the_bee?: BeePuzzle | null;
  headline: string;
  intro: string;
  sections: Array<{ id: string; title: string }>;
  section_order: string[];
  stories: PublicationPresentationStory[];
  story_order: string[];
};

export type PublicationDraft = {
  inclusion_version?: 1;
  _id: string;
  publication_id: string;
  origin?: "generated" | "manual";
  generation_id?: string;
  manual_creation?: { principal_id: string; request_hash: string };
  preference_snapshot?: PublicationPreferenceSnapshot;
  profile_snapshot?: ReturnType<typeof resolvePublicationSettings>["profile"];
  status: "ready";
  unpublished: boolean;
  editable: boolean;
  title: string;
  window: [string, string];
  locations: GenerationLocation[];
  stories: PublicationDraftStory[];
  versions: {
    publication: string;
    preferences: string;
    config: string;
    source_maps: Array<{ location_id: string; version: number | null }>;
  };
  telemetry: {
    actor: { id: string; email: string };
    funding: Array<{ funding: string; provider: string; model: string; role: string; ok: boolean; calls: number }>;
  };
  revision: number;
  editorial_status: "editing" | "ready_for_approval" | "approved" | "publishing" | "published";
  presentation: PublicationDraftPresentation;
  updated_at: number;
  updated_by: { id: string; email: string };
  ready_for_approval_at: number | null;
  ready_for_approval_by: { id: string; email: string } | null;
  approval?: {
    revision: number;
    content_hash: string;
    approved_by: PublicationActor;
    approved_at: number;
    snapshot: PublicationDraftSnapshotV1;
  };
  publish_claim?: {
    token: string;
    release_id: string;
    payload: PublicationReleasePayloadV1;
    content_hash: string;
    claimed_at: number;
    claimed_by: PublicationActor;
  };
  release?: {
    release_id: string;
    content_hash: string;
    payload: PublicationReleasePayloadV1;
    artifact_file_id: string;
    manifest_file_id?: string;
    manifest_revision?: number;
    published_at: number;
    published_by: PublicationActor;
  };
  correction?: {
    supersedes_release_id: string;
    reason: string;
    created_at: number;
    created_by: PublicationActor;
  };
  distribution: { reader: boolean; email: false };
  created_at: number;
};

type PublicationDocument = PublicationSettingsDocument & {
  destinations?: unknown[];
  enabled?: boolean;
};

type EditionEntry = {
  id: string;
  edition_id: string;
  position: number;
  disposition: string;
  story_id: string;
  event_date: string;
  section: string;
  result: Record<string, any>;
};

type ChildDraft = {
  id: string;
  run_id: string;
  status: string;
  published?: { items?: Array<Record<string, any>> };
};

const log = logger("publication-generation");
const now = () => Date.now() / 1000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const generations = (db: Db) => db.collection<PublicationGeneration>(COLLECTIONS.publicationGenerations);
const drafts = (db: Db) => db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts);

export async function ensurePublicationGenerationIndexes(db: Db) {
  await ensurePublicationGenerationAdmissionIndex(db);
  await Promise.all([
    generations(db).createIndexes([
      { key: { publication_id: 1, created_at: -1 }, name: "publication_generations_recent" },
      { key: { publication_id: 1, idempotency_key: 1 }, unique: true, name: "publication_generation_idempotency" },
    ]),
    drafts(db).createIndexes([
      { key: { publication_id: 1, created_at: -1 }, name: "publication_drafts_recent" },
      { key: { generation_id: 1 }, unique: true, partialFilterExpression: { generation_id: { $type: "string" } }, name: "one_draft_per_publication_generation_v2" },
    ]),
  ]);
  if (await drafts(db).indexExists("one_draft_per_publication_generation")) {
    try {
      await drafts(db).dropIndex("one_draft_per_publication_generation");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === 27)) throw error;
    }
  }
}

function parseDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid generation window date.");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid generation window date.");
  }
  return date;
}

function dayBefore(value: string) {
  const date = parseDay(value);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function validateWindow(value: unknown): [string, string] {
  if (!Array.isArray(value) || value.length !== 2 || value.some((day) => typeof day !== "string")) {
    throw new Error("Invalid generation window.");
  }
  const start = parseDay(value[0]);
  const end = parseDay(value[1]);
  const days = Math.round((end.valueOf() - start.valueOf()) / 86_400_000) + 1;
  if (days !== WINDOW_DAYS) throw new Error(`Invalid generation window: choose exactly ${WINDOW_DAYS} days.`);
  return [value[0], value[1]];
}

function validateIdempotencyKey(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new Error("Invalid generation request key.");
  }
  return value;
}

function publicationVersion(context: PublicationContext<PublicationDocument>) {
  const publication = context.publication;
  return hash({
    id: publication._id,
    owner_id: publication.owner_id,
    name: publication.name,
    selected_location_ids: publication.selected_location_ids ?? [],
    enabled: publication.enabled ?? false,
    destinations: publication.destinations ?? [],
    publication_scope_version: publication.publication_scope_version ?? null,
  });
}

export async function createManualPublicationDraft(
  db: Db,
  principal: Principal,
  input: { publicationId: string; locationIds: string[]; window: [string, string]; idempotencyKey: string },
) {
  return withSiteWriter(db, () => createManualPublicationDraftAdmitted(db, principal, input));
}

async function createManualPublicationDraftAdmitted(
  db: Db,
  principal: Principal,
  input: { publicationId: string; locationIds: string[]; window: [string, string]; idempotencyKey: string },
) {
  const key = validateIdempotencyKey(input.idempotencyKey);
  const window = validateWindow(input.window);
  const locationIds = [...new Set(input.locationIds)].sort();
  if (!locationIds.length || locationIds.length > MAX_PUBLICATION_GENERATION_LOCATIONS
    || locationIds.length !== input.locationIds.length) {
    throw new Error(`Invalid draft locations: choose 1 to ${MAX_PUBLICATION_GENERATION_LOCATIONS} unique locations.`);
  }
  const context = await resolvePublicationContext<PublicationDocument>(db, principal.id, input.publicationId)
    ?? (hasPublicationCapability(principal, "publication:inspect")
      ? await resolvePrivilegedPublicationContext<PublicationDocument>(db, principal, input.publicationId, "Start writing an edition", "write")
      : null);
  if (!context) throw new PublicationAccessDenied();
  await assertPublicationWrite(db, context, "create_manual_publication_draft", { audit: false });
  if (!context.publication.enabled) throw new Error("Invalid draft: this publication is paused.");
  const selected = await validateGenerationLocations(db, context, locationIds);
  await ensurePublicationGenerationIndexes(db);
  const id = `manual-${hash([context.id, principal.id, key])}`;
  const requestHash = hash({ locationIds, window });
  const retry = (draft: PublicationDraft) => {
    if (draft.manual_creation?.principal_id !== principal.id || draft.manual_creation.request_hash !== requestHash) {
      throw new RunConflict("This writing request key was already used with different edition details.");
    }
    return { draft, created: false };
  };
  const existing = await drafts(db).findOne({ _id: id, publication_id: context.id });
  if (existing) return retry(existing);
  const preferenceSnapshot = await publicationPreferenceSnapshot(db, context);
  const createdAt = now();
  const actor = { id: principal.id, email: principal.email };
  const title = `${context.publication.name} · ${window[0]} to ${window[1]}`;
  const locations = selected.map((profile) => ({
    id: profile.id, name: profile.name, source_map_version: profile.source_map_version ?? null,
  }));
  const draft: PublicationDraft = {
    _id: id, publication_id: context.id, origin: "manual", inclusion_version: 1,
    manual_creation: { principal_id: principal.id, request_hash: requestHash },
    preference_snapshot: preferenceSnapshot,
    profile_snapshot: resolvePublicationSettings(context.publication).profile,
    status: "ready", unpublished: true, editable: true, title, window, locations, stories: [],
    versions: {
      publication: publicationVersion(context), preferences: hash(preferenceSnapshot), config: PLAYBOOK_VERSION,
      source_maps: locations.map((location) => ({ location_id: location.id, version: location.source_map_version })),
    },
    telemetry: { actor, funding: [] },
    revision: 0, editorial_status: "editing",
    presentation: {
      headline: title, intro: "", sections: [{ id: "news", title: "News" }],
      section_order: ["news"], stories: [], story_order: [],
    },
    updated_at: createdAt, updated_by: actor,
    ready_for_approval_at: null, ready_for_approval_by: null,
    distribution: { reader: false, email: false }, created_at: createdAt,
  };
  try {
    return await publicationChangeTransaction(db, async (session) => {
      const raced = await drafts(db).findOne({ _id: id, publication_id: context.id }, { session });
      if (raced) return retry(raced);
      await assertPublicationWrite(db, context, "create_manual_publication_draft", { session });
      const claimed = await db.collection(COLLECTIONS.outputChannels).updateOne(
        publicationLifecycleFilter(context, context.publication.lifecycle_revision ?? 0),
        { $inc: { lifecycle_revision: 1 } }, { session },
      );
      if (!claimed.matchedCount) throw new PublicationLifecycleConflict();
      await drafts(db).insertOne(draft, { session });
      await appendPublicationChangeAudit(db, {
        publication_id: context.id, principal_id: principal.id, principal_email: principal.email,
        action: "manual_draft_created", resource_id: id, detail: "Started a private seven-day edition without generation",
        before_hash: null, after_hash: hash(draft),
      }, session);
      return { draft, created: true };
    });
  } catch (error) {
    // A concurrent retry may commit before this transaction claims the lifecycle revision.
    const raced = await drafts(db).findOne({ _id: id, publication_id: context.id });
    if (raced) return retry(raced);
    throw error;
  }
}

export async function validateGenerationLocations(
  db: Db,
  context: PublicationContext<PublicationDocument>,
  locationIds: string[],
) {
  const publicationLocations = new Set(context.publication.selected_location_ids ?? []);
  const allowedLocations = new Set(context.publication.allowed_location_ids ?? context.publication.selected_location_ids ?? []);
  if (locationIds.some((id) => !publicationLocations.has(id) || !allowedLocations.has(id))) {
    throw new Error("Invalid generation locations: every location must belong to this publication.");
  }
  const profiles = await listLocations(db);
  const selected = locationIds.map((id) => profiles.find((profile) => profile.id === id));
  if (selected.some((profile) => !profile)) {
    throw new Error("Invalid generation locations: one or more locations are no longer onboarded.");
  }
  const available = selected.map((profile) => profile!);
  const readiness = await locationReadinessForIds(db, available.map(({ id, name }) => ({ id, name })));
  const unavailable = readiness.filter((row) => !row.ready);
  if (unavailable.length) {
    throw new Error(`Invalid generation locations: ${unavailable.map((row) => `${row.location_name} is ${row.state}`).join(", ")}.`);
  }
  return available;
}

export async function startGenerationChildren(
  deps: OrchestratorDeps,
  principal: Principal,
  generation: PublicationGeneration,
) {
  let preferenceSnapshot = generation.preference_snapshot;
  if (!preferenceSnapshot) {
    const context = await resolvePublicationContext<PublicationDocument>(deps.db, principal.id, generation.publication_id)
      ?? (hasPublicationCapability(principal, "publication:inspect")
        ? await resolvePrivilegedPublicationContext<PublicationDocument>(deps.db, principal, generation.publication_id,
          "Recover missing publication generation preferences", "write") : null);
    if (!context) throw new PublicationAccessDenied();
    await assertPublicationWrite(deps.db, context, "recover_publication_generation_preferences");
    preferenceSnapshot = await publicationPreferenceSnapshot(deps.db, context);
    await generations(deps.db).updateOne({ _id: generation._id, preference_snapshot: { $exists: false } }, {
      $set: { preference_snapshot: preferenceSnapshot, preference_version: hash(preferenceSnapshot), updated_at: now() },
    });
  }
  const existingChildren = await runs(deps.db)
    .find({ publication_generation_id: generation._id })
    .sort({ created_at: 1, _id: 1 })
    .toArray();
  const childrenByLocation = new Map<string, PipelineRun>();
  const expectedLocations = new Set(generation.locations.map((location) => location.id));
  for (const child of existingChildren) {
    if (childrenByLocation.has(child.location_id)
      || !expectedLocations.has(child.location_id)
      || child.admission !== "publication"
      || child.publication_id !== generation.publication_id) {
      throw new RunConflict("The combined draft has incompatible location runs.");
    }
    childrenByLocation.set(child.location_id, child);
  }

  const childRunIds: string[] = [];
  for (const location of generation.locations) {
    const existing = childrenByLocation.get(location.id);
    if (existing) {
      if (existing.status !== "built" && existing.execution?.source !== "platform" && existing.execution?.sponsorId !== principal.id) {
        throw new ExecutionBlocked("Another journalist's legacy location work requires explicit publication recovery and audited funding.");
      }
      if (["failed", "cancelled", "published"].includes(existing.status)) {
        throw new RunConflict(`${existing.location_name} could not resume its combined draft.`);
      }
      if (existing.status === "collecting") {
        await enqueue(deps.db, {
          kind: "plan_sources",
          run_id: existing._id,
          location_id: existing.location_id,
          dedupe_key: `plan:${existing._id}`,
        });
      }
      childRunIds.push(existing._id);
      continue;
    }
    const child = await startRun(
      { ...deps, principal },
      location.id,
      { by: principal.email, kind: "manual" },
      generation.options,
      {
        publicationGenerationId: generation._id,
        publicationId: generation.publication_id,
        today: generation.today,
        window: generation.window,
        preferenceSnapshot,
        admissionLeaseHeld: true,
      },
    );
    if (!child.started || child.run.publication_generation_id !== generation._id) {
      throw new RunConflict(`Could not start ${child.run.location_name} as part of this combined draft.`);
    }
    childRunIds.push(child.run._id);
  }
  const updated = await generations(deps.db).findOneAndUpdate(
    { _id: generation._id, status: "starting" },
    {
      $set: {
        status: "running",
        child_run_ids: childRunIds,
        updated_at: now(),
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) throw new Error("The combined draft changed while starting.");
  return await reconcilePublicationGeneration(deps.db, generation._id) ?? updated;
}

async function failGenerationStart(db: Db, generationId: string, error: unknown) {
  if (error instanceof MaintenanceError) throw error;
  await ensurePublicationGenerationAdmissionIndex(db);
  const detail = error instanceof Error ? error.message : String(error);
  await generations(db).updateOne(
    { _id: generationId, status: "starting" },
    {
      $set: {
        status: "blocked",
        error: detail,
        execution_blocked: executionBlock(error),
        updated_at: now(),
        completed_at: null,
      },
    },
  );
}

/** Repair a persisted parent after a process stopped between child or initial-job writes. */
export async function recoverStartingPublicationGenerations(deps: OrchestratorDeps) {
  const starting = await generations(deps.db).find({
    status: "starting",
  }).sort({ created_at: 1, _id: 1 }).toArray();
  if (!starting.length) return 0;
  const lease = await acquireAdmissionLease(deps.db);
  if (!lease) return 0;
  let recovered = 0;
  try {
    for (const stored of starting) {
      const generation = await generations(deps.db).findOne({ _id: stored._id, status: "starting" });
      if (!generation) continue;
      try {
        const principal = await principalById(deps.db, generation.initiated_by);
        if (!principal) throw new PublicationAccessDenied();
        const context = await resolvePublicationContext<PublicationDocument>(
          deps.db,
          generation.initiated_by,
          generation.publication_id,
        ) ?? (hasPublicationCapability(principal, "publication:inspect")
          ? await resolvePrivilegedPublicationContext<PublicationDocument>(
            deps.db, principal, generation.publication_id, "Recover publication generation", "write",
          ) : null);
        if (!context || context.ownerId !== generation.owner_id) {
          throw new PublicationAccessDenied();
        }
        await assertPublicationWrite(deps.db, context, "recover_publication_generation");
        await assertGlobalAdmission(deps.db, undefined, generation._id);
        await validateGenerationLocations(
          deps.db,
          context,
          generation.locations.map((location) => location.id),
        );
        await startGenerationChildren(deps, principal, generation);
        recovered += 1;
      } catch (error) {
        await failGenerationStart(deps.db, generation._id, error);
        log.error("publication_generation_start_recovery_failed", {
          generation_id: generation._id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await releaseLease(deps.db, lease);
  }
  return recovered;
}

export async function startPublicationGeneration(
  deps: OrchestratorDeps,
  principal: Principal,
  input: {
    publicationId: string;
    locationIds: string[];
    window: [string, string];
    options?: unknown;
    idempotencyKey: string;
  },
) {
  await ensurePublicationGenerationIndexes(deps.db);
  const current = await principalById(deps.db, principal.id);
  if (!current) throw new PublicationAccessDenied();
  principal = current;
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const context = await resolvePublicationContext<PublicationDocument>(deps.db, principal.id, input.publicationId)
    ?? (hasPublicationCapability(principal, "publication:inspect")
      ? await resolvePrivilegedPublicationContext<PublicationDocument>(deps.db, principal, input.publicationId, "Start publication generation", "write")
      : null);
  if (!context) throw new PublicationAccessDenied();
  await assertPublicationWrite(deps.db, context, "start_publication_generation");
  const existing = await generations(deps.db).findOne({
    publication_id: context.id,
    idempotency_key: idempotencyKey,
  });
  if (existing && existing.status !== "starting") return { generation: existing, started: false };

  const locationIds = [...new Set(input.locationIds)];
  let window: [string, string] | null = null;
  let options: RunOptions | null = null;
  if (!existing) {
    if (!locationIds.length || locationIds.length > MAX_PUBLICATION_GENERATION_LOCATIONS
      || locationIds.length !== input.locationIds.length) {
      throw new Error(`Invalid generation locations: choose 1 to ${MAX_PUBLICATION_GENERATION_LOCATIONS} unique locations.`);
    }
    window = validateWindow(input.window);
    options = resolveRunOptions({ ...(input.options && typeof input.options === "object" ? input.options : {}), mode: "autopilot" });
  }
  const policy = await resolveExecutionProviderPolicy(deps.db, deps.settings, principal, { kind: "platform", publicationId: context.id });
  await preparePolicyBinding(policy, (existing?.locations[0]?.id ?? locationIds[0]), "edition", existing?.options ?? options);

  const lease = await acquireAdmissionLease(deps.db);
  if (!lease) throw new GlobalAdmissionConflict("Another generation is starting. Retry in a moment.");
  let generationId: string | null = existing?._id ?? null;
  try {
    const raced = await generations(deps.db).findOne({
      publication_id: context.id,
      idempotency_key: idempotencyKey,
    });
    if (raced && raced.status !== "starting") return { generation: raced, started: false };
    let generation = raced;
    if (generation) {
      generationId = generation._id;
      await assertGlobalAdmission(deps.db, undefined, generation._id);
      await validateGenerationLocations(deps.db, context, generation.locations.map((location) => location.id));
    } else {
      await assertGlobalAdmission(deps.db);
      const selected = await validateGenerationLocations(deps.db, context, locationIds);
      const preferenceSnapshot = await publicationPreferenceSnapshot(deps.db, context);
      generationId = randomUUID();
      const created = now();
      generation = {
        _id: generationId,
        admission: "newsroom",
        publication_id: context.id,
        publication_name: context.publication.name,
        owner_id: context.ownerId,
        initiated_by: principal.id,
        initiated_by_email: principal.email,
        idempotency_key: idempotencyKey,
        status: "starting",
        window: window!,
        today: dayBefore(window![0]),
        locations: selected.map((profile) => ({
          id: profile.id,
          name: profile.name,
          source_map_version: profile.source_map_version ?? null,
        })),
        child_run_ids: [],
        options: options!,
        publication_version: publicationVersion(context),
        preference_version: hash(preferenceSnapshot),
        preference_snapshot: preferenceSnapshot,
        config_version: PLAYBOOK_VERSION,
        managed_execution: policy.source === "platform",
        progress: { total: locationIds.length, completed: 0, failed: 0 },
        draft_id: null,
        error: null,
        created_at: created,
        updated_at: created,
        completed_at: null,
      };
      const newGeneration = generation;
      await publicationChangeTransaction(deps.db, async (session) => {
        const claimed = await deps.db.collection(COLLECTIONS.outputChannels).updateOne(
          publicationLifecycleFilter(context, context.publication.lifecycle_revision ?? 0),
          { $inc: { lifecycle_revision: 1 } }, { session },
        );
        if (!claimed.matchedCount) throw new PublicationLifecycleConflict();
        await generations(deps.db).insertOne(newGeneration, { session });
      });
    }
    return { generation: await startGenerationChildren(deps, principal, generation), started: true };
  } catch (error) {
    if (generationId) {
      await failGenerationStart(deps.db, generationId, error);
    }
    throw error;
  } finally {
    await releaseLease(deps.db, lease);
  }
}

function canonicalUrl(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

function sourcesOf(result: Record<string, any>): DraftSource[] {
  const rows = Array.isArray(result.sources) ? result.sources : [];
  const fallback = result.source_url ? [{ name: "Local source", url: result.source_url }] : [];
  const unique = new Map<string, DraftSource>();
  for (const source of [...rows, ...fallback]) {
    const url = canonicalUrl(source?.url);
    const name = typeof source?.name === "string" && source.name ? source.name : "Local source";
    const key = url ?? `name:${name}`;
    if (!unique.has(key)) unique.set(key, { name, url });
  }
  return [...unique.values()];
}

function flagsOf(entry: EditionEntry) {
  const values = [
    ...(Array.isArray(entry.result.validation_errors) ? entry.result.validation_errors : []),
    ...(Array.isArray(entry.result.flagged_errors) ? entry.result.flagged_errors : []),
    ...(entry.result.error ? [entry.result.error] : []),
  ];
  return [...new Set(values.map(String).filter(Boolean))];
}

function imageOf(result: Record<string, any>): Record<string, unknown> | null {
  return generatedImageSnapshot(result);
}

function mergeStoryGroups(target: PublicationDraftStory, source: PublicationDraftStory) {
  for (const location of source.location_tags) {
    if (!target.location_tags.some((candidate) => candidate.id === location.id)) {
      target.location_tags.push(location);
    }
  }
  target.references.push(...source.references);
  const sourceKeys = new Set(target.snapshot.sources.map((row) => row.url ?? `name:${row.name}`));
  const allSources = [...target.snapshot.sources];
  for (const row of source.snapshot.sources) {
    const key = row.url ?? `name:${row.name}`;
    if (!sourceKeys.has(key)) {
      sourceKeys.add(key);
      allSources.push(row);
    }
  }
  target.review.flags = [...new Set([...target.review.flags, ...source.review.flags])];
  if (source.review.status === "ready" && target.review.status === "held") {
    target.snapshot = { ...source.snapshot, sources: allSources };
    target.review.status = "ready";
  } else {
    target.snapshot.sources = allSources;
  }
}

function presentationFor(generation: PublicationGeneration, stories: PublicationDraftStory[]): PublicationDraftPresentation {
  const sectionIds = [...new Set(stories.map((story) => story.snapshot.section || "news"))];
  const sections = sectionIds.map((id) => ({
    id,
    title: id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
  }));
  const presentationStories = stories.map((story) => ({
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
    included: story.review.status === "ready",
  }));
  return {
    headline: `${generation.publication_name} · ${generation.window[0]} to ${generation.window[1]}`,
    intro: "",
    sections,
    section_order: sections.map((section) => section.id),
    stories: presentationStories,
    story_order: presentationStories.map((story) => story.id),
  };
}

async function mergePublicationDraft(db: Db, generation: PublicationGeneration, children: PipelineRun[]) {
  const existing = await drafts(db).findOne({ generation_id: generation._id });
  if (existing) return existing;
  const childIds = children.map((child) => child._id);
  const childDrafts = await db.collection<ChildDraft>(COLLECTIONS.editions)
    .find({ run_id: { $in: childIds } }).toArray();
  if (children.some((child) => child.status !== "built")
    || childDrafts.length !== children.length
    || childDrafts.some((draft) => draft.status !== "built")) {
    throw new Error("Every location draft must remain built and unpublished before combining.");
  }
  const draftById = new Map(childDrafts.map((draft) => [draft.id, draft]));
  const runByDraft = new Map(childDrafts.map((draft) => [draft.id, children.find((child) => child._id === draft.run_id)!]));
  const selectedByDraft = new Map(childDrafts.map((draft) => [
    draft.id,
    new Set((draft.published?.items ?? []).map((item) => String(item.story_id ?? "")).filter(Boolean)),
  ]));
  const entries = await db.collection<EditionEntry>(COLLECTIONS.editionEntries)
    .find({ edition_id: { $in: childDrafts.map((draft) => draft.id) } })
    .sort({ edition_id: 1, position: 1 })
    .toArray();
  const included = entries.filter((entry) =>
    entry.disposition === "held" || selectedByDraft.get(entry.edition_id)?.has(entry.story_id));
  const storyIds = [...new Set(included.map((entry) => entry.story_id))];
  const [items, fundingRows] = await Promise.all([
    collectedItems(db).find(
      { run_id: { $in: childIds }, story_id: { $in: storyIds } },
      { projection: { _id: 1, run_id: 1, story_id: 1 } },
    ).toArray(),
    db.collection<{
      run_id: string;
      funding: string;
      provider: string;
      model: string;
      role: string;
      ok: boolean;
    }>("journalist_funding_audit").find({ run_id: { $in: childIds } }).toArray(),
  ]);
  const itemIds = new Map<string, string[]>();
  for (const item of items) {
    const key = `${item.run_id}:${item.story_id}`;
    itemIds.set(key, [...(itemIds.get(key) ?? []), String(item._id)]);
  }

  const merged: PublicationDraftStory[] = [];
  const aliases = new Map<string, PublicationDraftStory>();
  for (const entry of included) {
    const run = runByDraft.get(entry.edition_id);
    const childDraft = draftById.get(entry.edition_id);
    if (!run || !childDraft) continue;
    const selected = selectedByDraft.get(entry.edition_id)?.has(entry.story_id) ?? false;
    const sources = sourcesOf(entry.result);
    const story = entry.result.story ?? {};
    const identityAliases = [
      ...sources.map((source) => source.url ? `source:${source.url}` : null),
      story.legacy_story_id ? `story:${story.legacy_story_id}` : null,
      story.id ? `story:${story.id}` : null,
      `story:${entry.story_id}`,
    ].filter((value): value is string => Boolean(value));
    const matched = [...new Set(identityAliases
      .map((identity) => aliases.get(identity))
      .filter((value): value is PublicationDraftStory => Boolean(value)))];
    let combined = matched[0];
    if (combined) {
      for (const duplicate of matched.slice(1)) {
        mergeStoryGroups(combined, duplicate);
        const index = merged.indexOf(duplicate);
        if (index >= 0) merged.splice(index, 1);
        for (const [identity, storyGroup] of aliases) {
          if (storyGroup === duplicate) aliases.set(identity, combined);
        }
      }
    }
    const reference = {
      run_id: run._id,
      draft_id: childDraft.id,
      entry_id: entry.id,
      story_id: entry.story_id,
      location_id: run.location_id,
      collected_item_ids: itemIds.get(`${run._id}:${entry.story_id}`) ?? [],
    };
    const snapshot = {
      headline: String(entry.result.draft?.headline ?? story.title ?? "Untitled story"),
      summary: String(entry.result.draft?.summary ?? story.description ?? ""),
      when_where: typeof entry.result.when_where === "string" ? entry.result.when_where : null,
      event_date: entry.event_date ?? null,
      kind: String(story.kind ?? "event"),
      section: entry.section ?? null,
      sources,
      image: imageOf(entry.result),
    };
    const flags = flagsOf(entry);
    if (!combined) {
      const canonicalIdentity = identityAliases[0];
      combined = {
        id: hash([generation._id, canonicalIdentity]).slice(0, 16),
        canonical_identity: canonicalIdentity,
        location_tags: [{ id: run.location_id, name: run.location_name }],
        references: [reference],
        snapshot,
        review: { status: selected ? "ready" : "held", flags, holds: publicationReviewHolds(flags) },
      };
      merged.push(combined);
    } else {
      if (!combined.location_tags.some((location) => location.id === run.location_id)) {
        combined.location_tags.push({ id: run.location_id, name: run.location_name });
      }
      combined.references.push(reference);
      const sourceKeys = new Set(combined.snapshot.sources.map((source) => source.url ?? `name:${source.name}`));
      for (const source of sources) {
        const key = source.url ?? `name:${source.name}`;
        if (!sourceKeys.has(key)) {
          sourceKeys.add(key);
          combined.snapshot.sources.push(source);
        }
      }
      combined.review.flags = [...new Set([...combined.review.flags, ...flags])];
      combined.review.holds = publicationReviewHolds(combined.review.flags);
      if (selected && combined.review.status === "held") {
        combined.snapshot = snapshot;
        combined.review.status = "ready";
      }
    }
    for (const identity of identityAliases) aliases.set(identity, combined);
  }
  merged.sort((left, right) =>
    Number(right.review.status === "ready") - Number(left.review.status === "ready")
    || left.snapshot.headline.localeCompare(right.snapshot.headline));

  const funding = new Map<string, PublicationDraft["telemetry"]["funding"][number]>();
  for (const row of fundingRows) {
    const key = [row.funding, row.provider, row.model, row.role, row.ok].join(":");
    const current = funding.get(key);
    if (current) current.calls += 1;
    else funding.set(key, {
      funding: row.funding,
      provider: row.provider,
      model: row.model,
      role: row.role,
      ok: row.ok,
      calls: 1,
    });
  }
  const createdAt = now();
  const draft: PublicationDraft = {
    inclusion_version: 1,
    _id: generation._id,
    publication_id: generation.publication_id,
    origin: "generated",
    generation_id: generation._id,
    status: "ready",
    unpublished: true,
    editable: true,
    title: `${generation.publication_name} · ${generation.window[0]} to ${generation.window[1]}`,
    window: generation.window,
    locations: generation.locations,
    stories: merged,
    versions: {
      publication: generation.publication_version,
      preferences: generation.preference_version,
      config: generation.config_version,
      source_maps: generation.locations.map((location) => ({
        location_id: location.id,
        version: location.source_map_version,
      })),
    },
    telemetry: {
      actor: { id: generation.initiated_by, email: generation.initiated_by_email },
      funding: [...funding.values()],
    },
    revision: 0,
    editorial_status: "editing",
    presentation: presentationFor(generation, merged),
    updated_at: createdAt,
    updated_by: { id: generation.initiated_by, email: generation.initiated_by_email },
    ready_for_approval_at: null,
    ready_for_approval_by: null,
    distribution: { reader: false, email: false },
    created_at: createdAt,
  };
  const draftImages = await generatedPublicationImages(db, draft);
  try {
    if (draftImages.length) {
      await publicationChangeTransaction(db, async (session) => {
        await drafts(db).insertOne(draft, { session });
        await db.collection<PublicationDraftImage>(COLLECTIONS.publicationImages).insertMany(draftImages, { session });
      });
    } else {
      await drafts(db).insertOne(draft);
    }
    return draft;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const raced = await drafts(db).findOne({ generation_id: generation._id });
      if (raced) return raced;
    }
    throw error;
  }
}

export async function reconcilePublicationGeneration(db: Db, generationId: string) {
  return withSiteWriter(db, () => reconcilePublicationGenerationAdmitted(db, generationId));
}

async function reconcilePublicationGenerationAdmitted(db: Db, generationId: string) {
  await assertSiteOpen(db);
  await ensurePublicationGenerationAdmissionIndex(db);
  const lease = await acquirePublicationGenerationLease(db, generationId);
  if (!lease) return generations(db).findOne({ _id: generationId });
  try {
    const generation = await generations(db).findOne({ _id: generationId });
    if (!generation || !ACTIVE_PUBLICATION_GENERATION_STATUSES.includes(generation.status as never)) return generation;
    if (generation.status === "starting") return generation;
    const children = await runs(db).find({ publication_generation_id: generationId }).sort({ created_at: 1 }).toArray();
    const completed = children.filter((child) => child.status === "built");
    if (generation.status === "cancelling") {
      await Promise.all(children.map((child) => cancelRunJobs(db, child._id)));
      // Do not infer that an executing request vanished, even when its lease expired.
      const executing = await db.collection(COLLECTIONS.jobs).countDocuments({
        run_id: { $in: children.map((child) => child._id) }, status: "running",
      });
      if (executing || await activeRunExecutions(db, children.map((child) => child._id))) return generation;
      await runs(db).updateMany({
        publication_generation_id: generationId, status: { $in: ACTIVE_RUN_STATUSES },
      }, { $set: { status: "cancelled", error: generation.error ?? "Combined generation cancelled.",
        completed_at: now(), updated_at: now() } });
      return generations(db).findOneAndUpdate({ _id: generationId, status: "cancelling" }, {
        $set: { status: "cancelled", completed_at: now(), updated_at: now(),
          progress: { total: generation.locations.length, completed: completed.length, failed: 0 } },
      }, { returnDocument: "after" });
    }
    if (generation.status === "blocked" || generation.status === "paused") {
      return generations(db).findOneAndUpdate({ _id: generationId, status: generation.status }, {
        $set: { progress: { total: generation.locations.length, completed: completed.length,
          failed: children.filter((child) => ["failed", "cancelled", "published"].includes(child.status)).length } },
      }, { returnDocument: "after" });
    }
    const invalid = children.filter((child) => ["failed", "cancelled", "published"].includes(child.status));
    const blocked = children.filter((child) => child.execution_blocked);
    if (blocked.length || invalid.length || generation.locations.length !== children.length
      || generation.child_run_ids.length !== children.length) {
      const detail = invalid.length
        ? invalid.map((child) => child.status === "published"
          ? `${child.location_name}: location draft was published outside the combined workflow`
          : `${child.location_name}: ${child.error ?? child.status}`).join("; ")
        : blocked.length ? blocked.map((child) => `${child.location_name}: ${child.execution_blocked!.reason}`).join("; ")
        : "One or more location runs are missing.";
      return generations(db).findOneAndUpdate(
        { _id: generationId, status: { $in: [...ACTIVE_PUBLICATION_GENERATION_STATUSES] } },
        {
          $set: {
            status: "blocked",
            error: detail,
            execution_blocked: blocked[0]?.execution_blocked ?? executionBlock(new ExecutionBlocked(detail)),
            progress: { total: generation.locations.length, completed: completed.length, failed: Math.max(1, invalid.length) },
            updated_at: now(),
            completed_at: null,
          },
        },
        { returnDocument: "after" },
      );
    }
    if (completed.length !== children.length) {
      await generations(db).updateOne(
        { _id: generationId, status: { $in: ["starting", "running"] } },
        {
          $set: {
            status: "running",
            progress: { total: generation.locations.length, completed: completed.length, failed: 0 },
            updated_at: now(),
          },
        },
      );
      return generations(db).findOne({ _id: generationId });
    }
    await generations(db).updateOne(
      { _id: generationId, status: { $in: ["starting", "running"] } },
      { $set: { status: "combining", updated_at: now() } },
    );
    const current = await generations(db).findOne({ _id: generationId });
    if (!current || current.status !== "combining") return current;
    const draft = await mergePublicationDraft(db, current, children);
    return generations(db).findOneAndUpdate(
      { _id: generationId, status: "combining" },
      {
        $set: {
          status: "ready",
          draft_id: draft._id,
          error: null,
          progress: { total: generation.locations.length, completed: children.length, failed: 0 },
          updated_at: now(),
          completed_at: now(),
        },
      },
      { returnDocument: "after" },
    );
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    await generations(db).updateOne(
      { _id: generationId, status: { $in: ["starting", "running", "combining"] } },
      {
        $set: {
          status: "blocked",
          error: detail,
          execution_blocked: executionBlock(error),
          updated_at: now(),
          completed_at: null,
        },
      },
    );
    throw error;
  } finally {
    await releaseLease(db, lease);
  }
}

export async function listPublicationGenerations(db: Db, publicationId: string, limit = 10, selectedId?: string | null) {
  const rows = await generations(db).find({ publication_id: publicationId })
    .sort({ created_at: -1, _id: -1 }).limit(limit).toArray();
  const active = await generations(db).findOne({
    publication_id: publicationId, status: { $in: [...ACTIVE_PUBLICATION_GENERATION_STATUSES] },
  });
  if (active && !rows.some((row) => row._id === active._id)) rows.push(active);
  for (const row of rows.filter((generation) =>
    ["running", "combining", "cancelling"].includes(generation.status))) {
    await reconcilePublicationGeneration(db, row._id);
  }
  const result = await generations(db).find({ publication_id: publicationId })
    .sort({ created_at: -1, _id: -1 }).limit(limit).toArray();
  for (const id of [active?._id, selectedId]) {
    if (id && !result.some((row) => row._id === id)) {
      const selected = await generations(db).findOne({ _id: id, publication_id: publicationId });
      if (selected) result.push(selected);
    }
  }
  return result;
}

export async function publicationGenerationChildren(db: Db, generationIds: string[]) {
  if (!generationIds.length) return [];
  const children = await runs(db).find(
    { publication_generation_id: { $in: generationIds } },
    {
      projection: {
        _id: 1,
        publication_generation_id: 1,
        location_id: 1,
        location_name: 1,
        status: 1,
        error: 1,
        execution_blocked: 1,
        created_at: 1,
        completed_at: 1,
      },
    },
  ).sort({ created_at: 1, _id: 1 }).toArray();
  if (!children.length) return [];
  const labels = {
    plan_sources: "Planning source checks",
    collect_source: "Checking sources",
    follow_links: "Checking sources",
    author_start: "Preparing story candidates",
    author_rank: "Reviewing story candidates",
    author_story: "Writing a story",
    image_story: "Preparing story images",
    stock_story: "Preparing story images",
    author_finish: "Saving community drafts",
  };
  // Group in Mongo: polling returns bounded counts/times, never job payloads or logs.
  const activity = await db.collection<Job>(COLLECTIONS.jobs).aggregate<{
    _id: { run: string; kind: keyof typeof labels; status: Job["status"] };
    completed: number;
    started_at: number | null;
    completed_at: number | null;
  }>([
    { $match: { run_id: { $in: children.map((child) => child._id) }, kind: { $in: Object.keys(labels) },
      status: { $in: ["running", "completed"] } } },
    { $project: {
      run_id: 1, kind: 1, status: 1, started_at: 1, completed_at: 1,
      finished: { $and: [
        { $eq: ["$status", "completed"] },
        { $ne: ["$result.skipped", true] }, { $ne: ["$result.cancelled", true] },
      ] },
    } },
    { $group: {
      _id: { run: "$run_id", kind: "$kind", status: "$status" },
      completed: { $sum: { $cond: ["$finished", 1, 0] } },
      started_at: { $max: { $cond: [{ $eq: ["$status", "running"] }, "$started_at", null] } },
      completed_at: { $max: { $cond: ["$finished", "$completed_at", null] } },
    } },
  ]).toArray();
  return children.map((child) => {
    const work: EditionWorkActivity = {
      source_checks_completed: 0, story_steps_completed: 0,
      active: [], last_started_at: null, last_completed_at: null,
    };
    for (const row of activity.filter((row) => row._id.run === child._id)) {
      if (row._id.kind === "collect_source" || row._id.kind === "follow_links") work.source_checks_completed += row.completed;
      if (row._id.kind === "author_story") work.story_steps_completed += row.completed;
      if (row._id.status === "running" && !work.active.includes(labels[row._id.kind])) work.active.push(labels[row._id.kind]);
      if (row.started_at !== null) work.last_started_at = Math.max(work.last_started_at ?? 0, row.started_at);
      if (row.completed_at !== null) work.last_completed_at = Math.max(work.last_completed_at ?? 0, row.completed_at);
    }
    return { ...child, work };
  });
}

export type EditionWorkActivity = {
  source_checks_completed: number;
  story_steps_completed: number;
  active: string[];
  last_started_at: number | null;
  last_completed_at: number | null;
};

export async function publicationGenerationDraft(db: Db, publicationId: string, draftId?: string | null) {
  return draftId
    ? drafts(db).findOne({ _id: draftId, publication_id: publicationId })
    : drafts(db).find({ publication_id: publicationId }).sort({ created_at: -1, _id: -1 }).limit(1).next();
}

/** The draft a journalist is most likely working on: the most recently edited unpublished edition. */
export async function currentPublicationDraftId(db: Db, publicationId: string) {
  const draft = await drafts(db).find(
    { publication_id: publicationId, editorial_status: { $in: ["editing", "ready_for_approval", "approved", "publishing"] } },
    { projection: { _id: 1 } },
  ).sort({ updated_at: -1, created_at: -1, _id: -1 }).limit(1).next();
  return draft?._id ?? null;
}

/** Draft counts by editorial status, for the journalist Overview. */
export async function publicationDraftStatusCounts(db: Db, publicationId: string) {
  const rows = await drafts(db).aggregate<{ _id: PublicationDraft["editorial_status"]; count: number }>([
    { $match: { publication_id: publicationId } },
    { $group: { _id: "$editorial_status", count: { $sum: 1 } } },
  ]).toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row.count])) as Partial<Record<PublicationDraft["editorial_status"], number>>;
}

export async function listPublicationDrafts(db: Db, publicationId: string, before?: string | null) {
  let cursor: { created_at: number; _id: string } | undefined;
  if (before) {
    try {
      cursor = JSON.parse(before);
    } catch {
      throw new Error("Invalid draft history cursor.");
    }
    if (!cursor || !Number.isFinite(cursor.created_at) || typeof cursor._id !== "string" || !cursor._id) {
      throw new Error("Invalid draft history cursor.");
    }
  }
  const rows = await drafts(db).find({
    publication_id: publicationId,
    ...(cursor ? { $or: [
      { created_at: { $lt: cursor.created_at } },
      { created_at: cursor.created_at, _id: { $lt: cursor._id } },
    ] } : {}),
  }, { projection: {
    _id: 1, origin: 1, generation_id: 1, title: 1, window: 1, editorial_status: 1,
    revision: 1, created_at: 1, correction: 1,
    "presentation.story_order": 1, "presentation.stories.id": 1, "presentation.stories.origin": 1,
    "presentation.stories.included": 1, "presentation.stories.generated_story_id": 1,
    "stories.id": 1, "stories.review.status": 1,
  } }).sort({ created_at: -1, _id: -1 }).limit(51).toArray();
  const page = rows.slice(0, 50).map(({ presentation, stories, ...row }) => ({
    ...row,
    story_count: presentation && stories
      ? includedPublicationStories({ presentation, stories } as PublicationDraft).length : null,
  }));
  const last = page.at(-1);
  return {
    drafts: page,
    nextCursor: rows.length > 50 && last ? JSON.stringify({ created_at: last.created_at, _id: last._id }) : null,
  };
}
