import type { Db } from "mongodb";
import type { PublicationPreview, PublicationReaderMetadata } from "../../../../shared/publication-preview";
import type { Principal } from "../accounts/identity";
import type { OutputChannelDocument } from "../orchestration/output-channels";
import { COLLECTIONS } from "../storage/mongo";
import { publicationEmailPublicUrl, PublicationEmailTokenError } from "../email/subscriptions";
import { accessiblePublicationFilter, type PublicationContext } from "./access";
import type { PublicationDraft } from "./generation";
import { hasPublicationCapability, requirePublicationCapability } from "./permissions";
import {
  publicationDraftSnapshot,
  PublicationReleaseConflict,
  PublicationReleaseNotFound,
  PublicationReleaseValidationError,
} from "./releases";
import { enabledSponsorPlacements, resolvePublicationSettings } from "./settings";

export function previewRevision(value: string | null) {
  if (!value || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new PublicationReleaseValidationError("Select an exact draft revision to preview.");
  }
  return Number(value);
}

export class PublicationReaderConfigurationError extends Error {}

export function publicationReaderBaseUrl() {
  if (!process.env.NEWSBEE_READER_SITE_URL?.trim()) return "/reader";
  // Reuse canonical Reader configuration validation, not a request-supplied redirect or credential.
  let root: string;
  try {
    root = publicationEmailPublicUrl().replace(/\/+$/, "");
  } catch (error) {
    if (!(error instanceof PublicationEmailTokenError)) throw error;
    throw new PublicationReaderConfigurationError(
      `Reader links and private preview are unavailable: ${error.message} Ask a deployment administrator to set an absolute HTTPS Reader URL (the deployed origin, optionally ending in /reader), then use Retry workspace links after the corrected main deployment is active. Newsroom profile and destination settings cannot repair this deployment setting. Permitted draft editing and saving remain available.`,
    );
  }
  const configured = new URL(root);
  return `${root}${configured.pathname.endsWith("/reader") ? "" : "/reader"}`;
}

export function publicationReaderMetadata(): PublicationReaderMetadata {
  try {
    return { readerBaseUrl: publicationReaderBaseUrl(), readerLink: { state: "available" } };
  } catch (error) {
    if (!(error instanceof PublicationReaderConfigurationError)) throw error;
    return { readerBaseUrl: null, readerLink: { state: "unavailable", detail: error.message } };
  }
}

export function publicationPreviewUrl(publicationId: string, draftId: string, revision: number) {
  return `${publicationReaderBaseUrl()}/publications/${encodeURIComponent(publicationId)}/drafts/${encodeURIComponent(draftId)}?revision=${revision}`;
}

/** No index initialization, migrations, audit writes, writer leases, or artifact publication. */
export async function loadPublicationPreview(
  db: Db,
  principal: Principal,
  publicationId: string,
  draftId: string,
  revision: number,
): Promise<PublicationPreview> {
  requirePublicationCapability(principal, "publication:read");
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new PublicationReleaseValidationError("Select an exact draft revision to preview.");
  }
  const accessFilter = hasPublicationCapability(principal, "publication:inspect")
    ? { _id: publicationId }
    : accessiblePublicationFilter<OutputChannelDocument>(principal.id, publicationId);
  const publications = db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels);
  const publication = await publications.findOne(accessFilter);
  if (!publication) throw new PublicationReleaseNotFound("Publication draft is unavailable.");
  const drafts = db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts);
  const filter = { _id: draftId, publication_id: publicationId };
  const draft = await drafts.findOne(filter);
  if (!draft) throw new PublicationReleaseNotFound("Publication draft is unavailable.");
  const available = (candidate: PublicationDraft) =>
    candidate.revision === revision && candidate.status === "ready" && candidate.unpublished && candidate.editable
    && !["publishing", "published"].includes(candidate.editorial_status) && !candidate.release;
  if (!available(draft)) {
    throw new PublicationReleaseConflict("The selected draft changed or is no longer available. Reload the editorial workspace.");
  }
  const context: PublicationContext<OutputChannelDocument> = {
    id: publicationId, ownerId: publication.owner_id, principalId: principal.id,
    role: publication.owner_id === principal.id ? "owner" : "editor", publication,
  };
  const snapshot = await publicationDraftSnapshot(db, context, draft);
  // Recheck after asynchronous media validation; never silently return a newer revision or revoked access.
  const [currentPublication, currentDraft] = await Promise.all([
    publications.findOne(accessFilter), drafts.findOne(filter),
  ]);
  if (!currentPublication) throw new PublicationReleaseNotFound("Publication draft is unavailable.");
  if (!currentDraft || !available(currentDraft)
    || JSON.stringify(currentPublication) !== JSON.stringify(publication)
    || JSON.stringify(currentDraft) !== JSON.stringify(draft)) {
    throw new PublicationReleaseConflict("The selected draft or publication changed. Reload the editorial workspace.");
  }
  const settings = resolvePublicationSettings(publication);
  return {
    kind: "publication-draft-preview",
    snapshot,
    publication: {
      id: publicationId, profile_revision: settings.profile.revision,
      display_name: settings.profile.values.display_name,
      description: settings.profile.values.description,
      homepage_url: settings.profile.values.homepage_url,
      logo_url: settings.profile.values.logo_url,
    },
    sponsor_placements: {
      revision: settings.sponsor_placements.revision,
      placements: enabledSponsorPlacements(settings),
    },
  };
}
