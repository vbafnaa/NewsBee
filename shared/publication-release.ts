import { createHash } from "node:crypto";
import { parseBeePuzzle, type BeePuzzle } from "./save-the-bee";
import {
  parsePublicationProfile,
  parseSponsorPlacements,
  type SponsorPlacement,
} from "./publication-settings";
import { safePublicHttpsUrl, type StoryImage } from "./story-image";
import {
  savedEditorialIllustration,
  type IllustrationId,
  type IllustrationAssetId,
  type ILLUSTRATION_POLICY,
} from "./editorial-illustrations";

export const PUBLICATION_RELEASE_SCHEMA_VERSION = 1 as const;

export type PublicationActor = {
  id: string;
  email: string;
};

export type PublicationReleaseLocation = {
  id: string;
  name: string;
};

export type PublicationReleaseSource = {
  name: string;
  url: string | null;
};

export type PublicationReleaseItem = Partial<StoryImage> & {
  illustration_id?: IllustrationId;
  illustration_asset_id?: IllustrationAssetId;
  illustration_policy?: typeof ILLUSTRATION_POLICY;
  item_id: string;
  story_id: string;
  origin: "generated" | "original";
  source_references: Array<{
    location_id: string;
    edition_id: string;
    story_id: string;
  }>;
  location_ids: string[];
  location_names: string[];
  section_id: string;
  section_title: string;
  headline: string;
  blurb: string;
  byline: string;
  when_where: string;
  event_date: string;
  source_url: string | null;
  sources: PublicationReleaseSource[];
  rank: number;
  kind: string;
};

export type PublicationDraftSnapshotV1 = {
  schema_version: typeof PUBLICATION_RELEASE_SCHEMA_VERSION;
  draft_id: string;
  draft_revision: number;
  title: string;
  intro: string;
  save_the_bee?: BeePuzzle;
  window_start: string;
  window_end: string;
  locations: PublicationReleaseLocation[];
  sections: Array<{ id: string; title: string }>;
  items: PublicationReleaseItem[];
  correction: {
    supersedes_release_id: string;
    reason: string;
  } | null;
};

export type PublicationReleasePayloadV1 = PublicationDraftSnapshotV1 & {
  release_id: string;
  publication: {
    id: string;
    profile_revision: number;
    display_name: string;
    description: string | null;
    homepage_url: string | null;
    logo_url: string | null;
  };
  sponsor_placements: {
    revision: number;
    placements: SponsorPlacement[];
  };
  approval: {
    draft_revision: number;
    draft_content_hash: string;
    approved_by: PublicationActor;
    approved_at: number;
  };
  published_by: PublicationActor;
  published_at: number;
};

export type PublicationReleaseManifestEntry = {
  release_id: string;
  title: string;
  window_start: string;
  window_end: string;
  published_at: number;
  content_hash: string;
  artifact_file_id: string;
  locations: PublicationReleaseLocation[];
  supersedes_release_id: string | null;
  withdrawn: boolean;
  withdrawal_reason: string | null;
};

export type PublicationManifestV1 = {
  schema_version: typeof PUBLICATION_RELEASE_SCHEMA_VERSION;
  publication: PublicationReleasePayloadV1["publication"];
  revision: number;
  generated_at: number;
  latest: PublicationReleaseManifestEntry | null;
  archive: PublicationReleaseManifestEntry[];
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

export function publicationContentHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function location(value: unknown): PublicationReleaseLocation | null {
  if (!record(value)) return null;
  const id = text(value.id, 256);
  const name = text(value.name, 240);
  return id && name ? { id, name } : null;
}

function actor(value: unknown): PublicationActor | null {
  if (!record(value)) return null;
  const id = text(value.id, 256);
  const email = text(value.email, 320);
  return id && email ? { id, email } : null;
}

function source(value: unknown): PublicationReleaseSource | null {
  if (!record(value)) return null;
  const name = text(value.name, 240);
  const url = value.url === null ? null : safePublicHttpsUrl(value.url);
  return name && (value.url === null || url) ? { name, url } : null;
}

function releaseItem(value: unknown): PublicationReleaseItem | null {
  if (!record(value)
    || !Array.isArray(value.location_ids)
    || !Array.isArray(value.location_names)
    || !Array.isArray(value.sources)
    || !Array.isArray(value.source_references)
    || value.location_ids.some((id) => !text(id, 256))
    || value.location_names.some((name) => !text(name, 240))
    || value.location_ids.length !== value.location_names.length
    || !Number.isInteger(value.rank) || Number(value.rank) < 1
  ) return null;
  if (value.source_references.some((reference) => !record(reference)
    || !text(reference.location_id, 256)
    || !text(reference.edition_id, 256)
    || !text(reference.story_id, 256))) return null;
  if (["illustration_id", "illustration_asset_id", "illustration_policy"].some((key) => key in value)
    && !savedEditorialIllustration(value)) return null;
  const itemId = text(value.item_id, 256);
  const storyId = text(value.story_id, 256);
  const origin = value.origin === "generated" || value.origin === "original" ? value.origin : null;
  const sectionId = text(value.section_id, 160);
  const sectionTitle = text(value.section_title, 120);
  const headline = text(value.headline, 240);
  const blurb = typeof value.blurb === "string" && value.blurb.length > 0 && value.blurb.length <= 20_000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.blurb) ? value.blurb : null;
  const byline = typeof value.byline === "string" && value.byline.length <= 240 ? value.byline : null;
  const whenWhere = typeof value.when_where === "string" && value.when_where.length <= 2000 ? value.when_where : null;
  const eventDate = typeof value.event_date === "string" && value.event_date.length <= 40 ? value.event_date : null;
  const sourceUrl = value.source_url === null ? null : safePublicHttpsUrl(value.source_url);
  const sources = value.sources.map(source);
  const kind = text(value.kind, 120);
  if (!itemId || !storyId || !origin || !sectionId || !sectionTitle || !headline || !blurb
    || byline === null || whenWhere === null || eventDate === null
    || value.source_url !== null && !sourceUrl || sources.some((entry) => entry === null) || !kind) return null;
  return {
    ...value,
    item_id: itemId,
    story_id: storyId,
    origin,
    location_ids: value.location_ids as string[],
    location_names: value.location_names as string[],
    section_id: sectionId,
    section_title: sectionTitle,
    headline,
    blurb,
    byline,
    when_where: whenWhere,
    event_date: eventDate,
    source_url: sourceUrl,
    sources: sources as PublicationReleaseSource[],
    rank: Number(value.rank),
    kind,
  } as PublicationReleaseItem;
}

export function parsePublicationRelease(value: unknown): PublicationReleasePayloadV1 | null {
  if (!record(value)
    || value.schema_version !== PUBLICATION_RELEASE_SCHEMA_VERSION
    || !record(value.publication)
    || !record(value.sponsor_placements)
    || !record(value.approval)
    || !Array.isArray(value.locations)
    || !Array.isArray(value.sections)
    || !Array.isArray(value.items)
  ) return null;
  const releaseId = text(value.release_id, 256);
  const draftId = text(value.draft_id, 256);
  const title = text(value.title, 240);
  const intro = typeof value.intro === "string" && value.intro.length <= 4000 ? value.intro : null;
  const windowStart = text(value.window_start, 40);
  const windowEnd = text(value.window_end, 40);
  const publicationId = text(value.publication.id, 256);
  const displayName = text(value.publication.display_name, 120);
  const approvedBy = actor(value.approval.approved_by);
  const publishedBy = actor(value.published_by);
  const locations = value.locations.map(location);
  const items = value.items.map(releaseItem);
  let profile;
  let sponsors;
  try {
    if (value.save_the_bee !== undefined) {
      const puzzle = parseBeePuzzle(value.save_the_bee);
      if (!record(value.save_the_bee) || puzzle.word !== value.save_the_bee.word
        || puzzle.clue !== value.save_the_bee.clue) return null;
    }
    profile = parsePublicationProfile({
      display_name: value.publication.display_name,
      description: value.publication.description,
      homepage_url: value.publication.homepage_url,
      logo_url: value.publication.logo_url,
    });
    sponsors = parseSponsorPlacements(value.sponsor_placements.placements);
  } catch {
    return null;
  }
  if (!releaseId || !draftId || !title || intro === null || !windowStart || !windowEnd
    || !publicationId || !displayName || !approvedBy || !publishedBy
    || profile.display_name !== displayName
    || sponsors.some((placement) => !placement.enabled)
    || !Number.isInteger(value.draft_revision) || Number(value.draft_revision) < 0
    || !Number.isInteger(value.publication.profile_revision) || Number(value.publication.profile_revision) < 0
    || !Number.isInteger(value.sponsor_placements.revision) || Number(value.sponsor_placements.revision) < 0
    || !Array.isArray(value.sponsor_placements.placements)
    || !Number.isInteger(value.approval.draft_revision) || Number(value.approval.draft_revision) < 0
    || !text(value.approval.draft_content_hash, 128)
    || typeof value.approval.approved_at !== "number"
    || typeof value.published_at !== "number"
    || locations.some((entry) => entry === null)
    || items.some((entry) => entry === null)
  ) return null;
  return value as PublicationReleasePayloadV1;
}

function validManifestEntry(value: unknown): value is PublicationReleaseManifestEntry {
  return record(value)
    && Boolean(text(value.release_id, 256))
    && Boolean(text(value.title, 240))
    && Boolean(text(value.window_start, 40))
    && Boolean(text(value.window_end, 40))
    && typeof value.published_at === "number"
    && Boolean(text(value.content_hash, 128))
    && Boolean(text(value.artifact_file_id, 4096))
    && Array.isArray(value.locations)
    && value.locations.every((candidate) => Boolean(location(candidate)))
    && (value.supersedes_release_id === null || Boolean(text(value.supersedes_release_id, 256)))
    && typeof value.withdrawn === "boolean"
    && (value.withdrawal_reason === null || Boolean(text(value.withdrawal_reason, 1000)));
}

export function parsePublicationManifest(value: unknown): PublicationManifestV1 | null {
  if (!record(value)
    || value.schema_version !== PUBLICATION_RELEASE_SCHEMA_VERSION
    || !record(value.publication)
    || !Array.isArray(value.archive)
    || !Number.isInteger(value.revision) || Number(value.revision) < 1
    || typeof value.generated_at !== "number"
  ) return null;
  const publicationId = text(value.publication.id, 256);
  const displayName = text(value.publication.display_name, 120);
  if (!publicationId || !displayName) return null;
  if (!value.archive.every(validManifestEntry)) return null;
  const latest = value.latest;
  if (latest !== null) {
    if (!validManifestEntry(latest)) return null;
    const archived = value.archive.find((entry) => entry.release_id === latest.release_id);
    if (!archived || canonicalJson(archived) !== canonicalJson(latest)) return null;
  }
  return value as PublicationManifestV1;
}
