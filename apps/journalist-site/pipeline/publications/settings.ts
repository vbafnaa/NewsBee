import { createHash } from "node:crypto";
import type { Db, Filter } from "mongodb";
import {
  PUBLICATION_SETTINGS_SCHEMA_VERSION,
  defaultPublicationSettings,
  parseGenerationPreferences,
  parsePublicationProfile,
  parseSponsorPlacements,
  type PublicationGenerationPreferenceValues,
  type PublicationPreferenceSnapshot,
  type PublicationSettingsPatch,
  type PublicationSettingsView,
  type SponsorPlacement,
  type VersionedPublicationSetting,
} from "../../../../shared/publication-settings";
import { validateEditorialPhoto } from "../../../../shared/image-validation";
import type { Principal } from "../accounts/identity";
import { COLLECTIONS } from "../storage/mongo";
import { assertPublicationWrite, authorizedPublicationFilter, type PublicationContext, type PublicationRecord } from "./access";
import { appendPublicationChangeAudit, publicationChangeTransaction } from "./audit";
import { requirePublicationCapability } from "./permissions";

export type PublicationSettingsDocument = PublicationRecord & {
  profile?: VersionedPublicationSetting<PublicationSettingsView["profile"]["values"]>;
  generation_preferences?: VersionedPublicationSetting<PublicationGenerationPreferenceValues>;
  sponsor_placements?: VersionedPublicationSetting<SponsorPlacement[]>;
};

export class PublicationSettingsConflict extends Error {}
export class PublicationSettingsValidationError extends Error {}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function versioned<T>(stored: VersionedPublicationSetting<T> | undefined, fallback: VersionedPublicationSetting<T>) {
  return stored?.schema_version === PUBLICATION_SETTINGS_SCHEMA_VERSION
    && Number.isInteger(stored.revision) && stored.revision >= 1
    ? stored
    : fallback;
}

export function resolvePublicationSettings(document: PublicationSettingsDocument): PublicationSettingsView {
  const defaults = defaultPublicationSettings(document.name);
  return {
    profile: versioned(document.profile, defaults.profile),
    generation_preferences: versioned(document.generation_preferences, defaults.generation_preferences),
    sponsor_placements: versioned(document.sponsor_placements, defaults.sponsor_placements),
  };
}

export async function getPublicationSettings(db: Db, context: PublicationContext) {
  const document = await db.collection<PublicationSettingsDocument>(COLLECTIONS.outputChannels)
    .findOne(authorizedPublicationFilter<PublicationSettingsDocument>(context));
  if (!document) return null;
  return resolvePublicationSettings(document);
}

export async function publicationPreferenceSnapshot(db: Db, context: PublicationContext): Promise<PublicationPreferenceSnapshot> {
  const settings = await getPublicationSettings(db, context);
  if (!settings) throw new Error("Publication was not found");
  return {
    publication_id: context.id,
    schema_version: PUBLICATION_SETTINGS_SCHEMA_VERSION,
    revision: settings.generation_preferences.revision,
    explicit_values: settings.generation_preferences.values,
  };
}

function expectedRevision(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 0) throw new PublicationSettingsValidationError("Expected revision must be a non-negative integer");
  return Number(value);
}

function revisionClause(field: string, revision: number, stored: unknown) {
  if (revision !== 0) return { [`${field}.revision`]: revision };
  if (stored === undefined) return { [field]: { $exists: false } };
  return { $and: [{ [field]: { $exists: true } }, { [field]: stored }] };
}

async function validateChangedImages(
  current: PublicationSettingsView,
  nextProfile: PublicationSettingsView["profile"]["values"] | null,
  nextSponsors: SponsorPlacement[] | null,
  validateImage: (url: string) => Promise<unknown>,
) {
  if (nextProfile?.logo_url && nextProfile.logo_url !== current.profile.values.logo_url) await validateImage(nextProfile.logo_url);
  if (nextSponsors) {
    const previous = new Map(current.sponsor_placements.values.map((placement) => [placement.id, placement.image_url]));
    for (const placement of nextSponsors) {
      if (placement.image_url && previous.get(placement.id) !== placement.image_url) await validateImage(placement.image_url);
    }
  }
}

export async function updatePublicationSettings(
  db: Db,
  context: PublicationContext,
  principal: Principal,
  patch: PublicationSettingsPatch,
  validateImage: (url: string) => Promise<unknown> = validateEditorialPhoto,
) {
  requirePublicationCapability(principal, "publication:write");
  await assertPublicationWrite(db, context, "update_publication_settings");
  const document = await db.collection<PublicationSettingsDocument>(COLLECTIONS.outputChannels)
    .findOne(authorizedPublicationFilter<PublicationSettingsDocument>(context));
  if (!document) return null;
  const current = resolvePublicationSettings(document);
  const updates: Record<string, unknown> = {};
  const clauses: Filter<PublicationSettingsDocument>[] = [
    authorizedPublicationFilter<PublicationSettingsDocument>(context),
  ];
  const audits: Array<{
    action: "profile_updated" | "generation_preferences_updated" | "sponsor_placements_updated";
    resource: string;
    before: unknown;
    after: unknown;
  }> = [];
  let nextProfile: PublicationSettingsView["profile"]["values"] | null = null;
  let nextSponsors: SponsorPlacement[] | null = null;
  const updatedAt = Date.now();

  try {
    if (patch.profile) {
      const expected = expectedRevision(patch.profile.expected_revision);
      if (expected !== current.profile.revision) throw new PublicationSettingsConflict("Publication profile changed; reload and try again");
      nextProfile = parsePublicationProfile(patch.profile.values);
      updates.profile = { schema_version: PUBLICATION_SETTINGS_SCHEMA_VERSION, revision: expected + 1, values: nextProfile, updated_at: updatedAt, updated_by: principal.id };
      clauses.push(revisionClause("profile", expected, document.profile) as Filter<PublicationSettingsDocument>);
      audits.push({ action: "profile_updated", resource: "profile", before: current.profile.values, after: nextProfile });
    }
    if (patch.generation_preferences) {
      const expected = expectedRevision(patch.generation_preferences.expected_revision);
      if (expected !== current.generation_preferences.revision) throw new PublicationSettingsConflict("Generation preferences changed; reload and try again");
      const values = parseGenerationPreferences(patch.generation_preferences.values);
      updates.generation_preferences = { schema_version: PUBLICATION_SETTINGS_SCHEMA_VERSION, revision: expected + 1, values, updated_at: updatedAt, updated_by: principal.id };
      clauses.push(revisionClause("generation_preferences", expected, document.generation_preferences) as Filter<PublicationSettingsDocument>);
      audits.push({ action: "generation_preferences_updated", resource: "generation_preferences", before: current.generation_preferences.values, after: values });
    }
    if (patch.sponsor_placements) {
      const expected = expectedRevision(patch.sponsor_placements.expected_revision);
      if (expected !== current.sponsor_placements.revision) throw new PublicationSettingsConflict("Sponsor placements changed; reload and try again");
      nextSponsors = parseSponsorPlacements(patch.sponsor_placements.values);
      updates.sponsor_placements = { schema_version: PUBLICATION_SETTINGS_SCHEMA_VERSION, revision: expected + 1, values: nextSponsors, updated_at: updatedAt, updated_by: principal.id };
      clauses.push(revisionClause("sponsor_placements", expected, document.sponsor_placements) as Filter<PublicationSettingsDocument>);
      audits.push({ action: "sponsor_placements_updated", resource: "sponsor_placements", before: current.sponsor_placements.values, after: nextSponsors });
    }
  } catch (error) {
    if (error instanceof PublicationSettingsConflict || error instanceof PublicationSettingsValidationError) throw error;
    throw new PublicationSettingsValidationError(error instanceof Error ? error.message : String(error));
  }
  if (!audits.length) throw new PublicationSettingsValidationError("Submit at least one publication settings block");
  try {
    await validateChangedImages(current, nextProfile, nextSponsors, validateImage);
  } catch (error) {
    throw new PublicationSettingsValidationError(error instanceof Error ? error.message : String(error));
  }
  await publicationChangeTransaction(db, async (session) => {
    const result = await db.collection<PublicationSettingsDocument>(COLLECTIONS.outputChannels)
      .updateOne({ $and: clauses }, { $set: updates }, { session });
    if (!result.matchedCount) throw new PublicationSettingsConflict("Publication settings changed; reload and try again");
    for (const audit of audits) {
      await appendPublicationChangeAudit(db, {
        publication_id: context.id,
        principal_id: principal.id,
        principal_email: principal.email,
        action: audit.action,
        resource_id: audit.resource,
        detail: `Updated ${audit.resource.replaceAll("_", " ")}`,
        before_hash: hash(audit.before),
        after_hash: hash(audit.after),
      }, session);
    }
  });
  return getPublicationSettings(db, context);
}

export function enabledSponsorPlacements(settings: PublicationSettingsView) {
  return settings.sponsor_placements.values.filter((placement) => placement.enabled);
}

export function decoratePublicationEdition(publication: PublicationSettingsDocument, edition: Record<string, unknown>) {
  const settings = resolvePublicationSettings(publication);
  return {
    ...edition,
    publication: {
      id: publication._id,
      schema_version: settings.profile.schema_version,
      revision: settings.profile.revision,
      display_name: settings.profile.values.display_name,
      description: settings.profile.values.description,
      homepage_url: settings.profile.values.homepage_url,
      logo_url: settings.profile.values.logo_url,
    },
    sponsor_placements: {
      schema_version: settings.sponsor_placements.schema_version,
      revision: settings.sponsor_placements.revision,
      placements: enabledSponsorPlacements(settings),
    },
  };
}
