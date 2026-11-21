import type { Edition } from "./reader-data";
import type { PublicationPreview } from "../../../../shared/publication-preview";
import type { PublicationDraftSnapshotV1, PublicationReleasePayloadV1 } from "../../../../shared/publication-release";
import { loadReaderPublication } from "./reader-data";
import {
  editionPageFromEdition,
  type EditionPage,
  type RenderableEdition,
} from "./edition-view";

export type PublicationPage = EditionPage & {
  beeGame?: { api: string; preview: boolean };
  publication: {
    id: string;
    displayName: string;
    description: string | null;
    homepageUrl: string | null;
    logoUrl: string | null;
  };
  release: {
    id: string;
    contentHash: string;
    withdrawn: boolean;
    withdrawalReason: string | null;
    correction: {
      supersedesReleaseId: string;
      reason: string;
    } | null;
  } | null;
  preview?: { draftId: string; revision: number; correction: PublicationDraftSnapshotV1["correction"] };
  coveredLocations: Array<{ id: string; name: string }>;
};

export function publicationLinks(publicationId: string, releaseId?: string | null) {
  const home = import.meta.env.BASE_URL.replace(/\/$/, "");
  const publication = `${home}/publications/${encodeURIComponent(publicationId)}`;
  const page = releaseId
    ? `${publication}/releases/${encodeURIComponent(releaseId)}`
    : publication;
  return {
    home,
    publication,
    page,
    archive: `${publication}/archive`,
    section: (section: string) => `${page}?section=${encodeURIComponent(section)}`,
    events: (day?: string) => `${page}?section=events${day ? `&day=${encodeURIComponent(day)}` : ""}`,
    story: (story: string) => `${page}?story=${encodeURIComponent(story)}`,
    location: (locationId: string) => `${home}/locations/${encodeURIComponent(locationId)}`,
    locationSignup: (locationId: string) => `${home}/subscribe?location=${encodeURIComponent(locationId)}`,
    newsletter: `${home}/subscribe?publication=${encodeURIComponent(publicationId)}${releaseId ? `&release=${encodeURIComponent(releaseId)}` : ""}`,
    contribute: (kind: "share" | "suggest", locationId?: string) =>
      `${home}/${kind}?${new URLSearchParams({
        publication: publicationId,
        ...(releaseId ? { release: releaseId } : {}),
        ...(locationId ? { location: locationId } : {}),
      })}`,
    browse: (locationId?: string) => `${home}/browse${locationId ? `?location=${encodeURIComponent(locationId)}` : ""}`,
  };
}

export function publicationPreviewLinks(publicationId: string, draftId: string, revision: number) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const path = `${base}/publications/${encodeURIComponent(publicationId)}/drafts/${encodeURIComponent(draftId)}`;
  const page = `${path}?revision=${revision}`;
  return {
    home: page, publication: page, page, archive: `${page}#draft-preview`,
    section: (section: string) => `${page}&section=${encodeURIComponent(section)}`,
    events: (day?: string) => `${page}&section=events${day ? `&day=${encodeURIComponent(day)}` : ""}`,
    story: (story: string) => `${page}&story=${encodeURIComponent(story)}`,
    location: (_locationId: string) => `${page}#draft-preview`,
    locationSignup: (_locationId: string) => `${page}#newsletter`,
    newsletter: `${page}#newsletter`,
    contribute: (_kind: "share" | "suggest", _locationId?: string) => `${page}#draft-preview`,
    browse: (_locationId?: string) => `${page}&section=all`,
    image: (story: string) => `${base}/api/publications/${encodeURIComponent(publicationId)}/drafts/${encodeURIComponent(draftId)}/preview?revision=${revision}&image=${encodeURIComponent(story)}`,
  };
}

export function publicationPageLinks(page: PublicationPage) {
  return page.preview
    ? publicationPreviewLinks(page.publication.id, page.preview.draftId, page.preview.revision)
    : publicationLinks(page.publication.id, page.release!.id);
}

export async function loadPublicationContributionContext(params: URLSearchParams) {
  const publicationId = params.get("publication");
  if (!publicationId) return null;
  const loaded = await loadReaderPublication(publicationId, params.get("release"));
  if (!loaded || loaded.entry.withdrawn) return null;
  const locations = loaded.release.locations;
  const selected = params.get("location");
  return {
    name: loaded.release.publication.display_name,
    links: publicationLinks(publicationId, loaded.release.release_id),
    locations,
    locationId: selected
      ? locations.some((location) => location.id === selected) ? selected : null
      : locations.length === 1 ? locations[0].id : null,
    invalidLocation: Boolean(selected && !locations.some((location) => location.id === selected)),
  };
}

export async function loadPublicationPage(
  publicationId: string,
  releaseId?: string | null,
  now = new Date(),
): Promise<PublicationPage | null> {
  const loaded = await loadReaderPublication(publicationId, releaseId);
  if (!loaded) return null;
  const { release, entry } = loaded;
  return publicationPageFromSnapshot(release, release.publication, release.sponsor_placements, {
    id: release.release_id, contentHash: entry.content_hash, withdrawn: entry.withdrawn,
    withdrawalReason: entry.withdrawal_reason,
    correction: release.correction ? {
      supersedesReleaseId: release.correction.supersedes_release_id, reason: release.correction.reason,
    } : null,
  }, release.published_at, now);
}

export async function loadPublicationRoute(publicationId: string, releaseId: string | null, storyId: string | null) {
  let page: PublicationPage | null;
  try {
    page = await loadPublicationPage(publicationId, releaseId);
  } catch (cause) {
    console.error("Publication release unavailable", cause);
    return { page: null, status: 502, error: "This publication release failed integrity validation or is temporarily unavailable." };
  }
  if (!page) {
    return { page: null, status: 404, error: releaseId
      ? "This publication release could not be found." : "This publication has no current release." };
  }
  if (storyId && !page.articles.some((article) => article.key === storyId)) {
    return { page: null, status: 404, error: "This story could not be found in the selected release." };
  }
  return { page, status: 200, error: "" };
}

export function publicationPreviewPage(preview: PublicationPreview, now = new Date()): PublicationPage {
  return publicationPageFromSnapshot(preview.snapshot, preview.publication, preview.sponsor_placements, null, null, now);
}

function publicationPageFromSnapshot(
  release: PublicationDraftSnapshotV1,
  publication: PublicationReleasePayloadV1["publication"],
  sponsors: PublicationReleasePayloadV1["sponsor_placements"],
  released: PublicationPage["release"],
  publishedAt: number | null,
  now: Date,
): PublicationPage {
  const publicationId = publication.id;
  const links = released ? publicationLinks(publicationId, released.id)
    : publicationPreviewLinks(publicationId, release.draft_id, release.draft_revision);
  const edition: RenderableEdition = {
    publication_release: true,
    media_mode: release.items.some((item) => item.image) ? "photos"
      : release.items.some((item) => item.illustration_id) ? "illustrated" : "none",
    id: released?.id ?? release.draft_id,
    location_id: publicationId,
    location_name: publication.display_name,
    window_start: release.window_start,
    window_end: release.window_end,
    published_at: publishedAt,
    ...(!released ? { private_image_hrefs: Object.fromEntries(release.items.filter((item) => item.image).map((item) => [
      item.item_id, publicationPreviewLinks(publicationId, release.draft_id, release.draft_revision).image(item.item_id),
    ])) } : {}),
    headline: release.title,
    intro: release.intro,
    items: release.items.map((item) => ({
      ...item,
      kind: item.kind as Edition["items"][number]["kind"],
      sources: item.sources.flatMap((source) => source.url ? [{ name: source.name, url: source.url }] : []),
      reader_href: links.story(item.item_id),
    })),
    coverage: release.locations.map((location) => location.name),
    corrections: release.correction && publishedAt !== null ? [{
      reason: release.correction.reason,
      created_at: publishedAt,
    }] : [],
    sections: release.sections,
    publication: {
      id: publicationId,
      schema_version: 1,
      revision: publication.profile_revision,
      display_name: publication.display_name,
      description: publication.description,
      homepage_url: publication.homepage_url,
      logo_url: publication.logo_url,
    },
    sponsor_placements: {
      schema_version: 1,
      revision: sponsors.revision,
      placements: sponsors.placements,
    },
  };
  const base = editionPageFromEdition(
    edition,
    { id: publicationId, name: publication.display_name },
    release.locations,
    released?.id ?? null,
    now,
  );
  return {
    ...base,
    town: publication.display_name,
    publication: {
      id: publicationId,
      displayName: publication.display_name,
      description: publication.description,
      homepageUrl: publication.homepage_url,
      logoUrl: publication.logo_url,
    },
    release: released,
    ...(!released ? { preview: { draftId: release.draft_id, revision: release.draft_revision, correction: release.correction } } : {}),
    coveredLocations: release.locations,
    ...(release.save_the_bee && !released?.withdrawn ? {
      beeGame: {
        api: `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/save-the-bee?${new URLSearchParams({
          publication: publicationId,
          ...(released ? { release: released.id }
            : { draft: release.draft_id, revision: String(release.draft_revision) }),
        })}`,
        preview: !released,
      },
    } : {}),
  };
}
