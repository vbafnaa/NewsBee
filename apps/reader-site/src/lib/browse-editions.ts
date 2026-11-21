import type {
  Edition,
  EditionItem,
  Location,
  ReaderPublicationBrowseRelease,
} from "./reader-data";
import { TOPICS, topicOfFiled } from "../../../../shared/topics";

export const BROWSE_PAGE_SIZE = 20;
export const HISTORY_PAGE_SIZE = 10;
const VERSION_LINK_LIMIT = 5;
const EDITION_OPTION_LIMIT = 50;

export const BROWSE_TOPICS = [
  ...TOPICS,
  { id: "events", label: "Events" },
  { id: "alerts", label: "Safety & Weather" },
  { id: "courts", label: "Courts" },
  { id: "remembrance", label: "Remembrances" },
  { id: "other", label: "Other News" },
] as const;

export type BrowseFilters = {
  location: string; edition: string; q: string; topic: string; page: number; historyPage: number;
};
export type BrowseEdition = {
  id: string; locationId: string; locationName: string; headline: string;
  locationIds: string[]; windowStart: string; windowEnd: string; publishedAt: number;
  storyCount: number | null; href: string; kind: "legacy" | "publication";
  publicationName: string | null; searchable: boolean; withdrawn: boolean;
};
type StoryVersion = {
  headline: string; summary: string; eventDate: string; topic: string; topicLabel: string;
  locationId: string; locationName: string; editionId: string; publishedAt: number;
  editionHref: string; href: string; rank: number; identity: string;
  publicationName: string | null; kind: "legacy" | "publication";
};
export type BrowseStory = Omit<StoryVersion, "rank" | "identity"> & {
  versionCount: number;
  otherVersions: { editionId: string; publishedAt: number; href: string }[];
};
type ReaderCatalog = {
  locations: readonly Location[];
  editions: readonly Edition[];
  publicationReleases?: readonly ReaderPublicationBrowseRelease[];
  publicationLocations?: readonly Location[];
};
type BrowseItemIdentity = {
  story_id?: string | null;
  source_references?: Array<{ location_id: string; story_id: string }>;
  headline: string;
  blurb: string;
  event_date: string;
  source_url: string | null;
  kind?: string | null;
  section_id?: string | null;
};

const pageNumber = (value: string | null) => /^\d{1,6}$/.test(value ?? "") ? Math.max(1, Number(value)) : 1;
const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US");

export function browseFilters(params: URLSearchParams): BrowseFilters {
  return {
    location: (params.get("location") ?? "").slice(0, 120),
    edition: (params.get("edition") ?? "").slice(0, 200),
    q: (params.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 200),
    topic: (params.get("topic") ?? "").slice(0, 40),
    page: pageNumber(params.get("page")),
    historyPage: pageNumber(params.get("historyPage")),
  };
}

export function editionHref(base: string, locationId: string, editionId?: string) {
  const params = new URLSearchParams({ location: locationId });
  if (editionId) params.set("edition", editionId);
  return `${base.replace(/\/$/, "")}?${params}`;
}

export function publicationReleaseHref(base: string, publicationId: string, releaseId: string, storyId?: string) {
  const root = base.replace(/\/$/, "");
  const url = `${root}/publications/${encodeURIComponent(publicationId)}/releases/${encodeURIComponent(releaseId)}`;
  return storyId ? `${url}?story=${encodeURIComponent(storyId)}` : url;
}

/** Exact original item indices keep ID-less archived story links stable. */
export function publishedStoryHref(base: string, edition: Pick<Edition, "id" | "location_id">, item: Pick<EditionItem, "story_id">, index: number) {
  const params = new URLSearchParams({ location: edition.location_id, edition: edition.id, story: item.story_id || `item:${index + 1}` });
  return `${base.replace(/\/$/, "")}?${params}`;
}

export function browseHref(base: string, filters: Partial<BrowseFilters> = {}) {
  const params = new URLSearchParams();
  for (const key of ["location", "edition", "q", "topic"] as const) if (filters[key]) params.set(key, filters[key]!);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  if (filters.historyPage && filters.historyPage > 1) params.set("historyPage", String(filters.historyPage));
  return `${base.replace(/\/$/, "")}/browse${params.size ? `?${params}` : ""}`;
}

function topic(item: BrowseItemIdentity) {
  if (item.kind === "event" || item.kind === "meeting_preview") return "events";
  if (["safety_notice", "safety_incident", "weather_alert", "earthquake"].includes(item.kind ?? "")) return "alerts";
  if (item.kind === "court_case") return "courts";
  if (item.kind === "obituary") return "remembrance";
  return topicOfFiled({ kind: item.kind, title: item.headline, description: item.blurb, section_id: item.section_id }) ?? "other";
}

function identity(locationId: string, item: BrowseItemIdentity, publicationId?: string) {
  const reference = item.source_references?.[0];
  if (reference) return `${reference.location_id}:id:${reference.story_id}`;
  if (item.story_id) return `${publicationId ? `publication:${publicationId}` : locationId}:id:${item.story_id}`;
  // A source URL alone may be a calendar or records page shared by many stories.
  return `${publicationId ? `publication:${publicationId}` : locationId}:fallback:${fold(item.headline).trim()}|${item.event_date}|${item.source_url ?? ""}`;
}

/** Accept only the public reader-folder catalog; never query editorial collections. */
export function buildBrowsePage(data: ReaderCatalog, filters: BrowseFilters, base = "", now = Date.now() / 1000) {
  const publicationReleases = (data.publicationReleases ?? [])
    .filter((release) => Number.isFinite(release.published_at) && release.published_at > 0 && release.published_at <= now);
  const directory = new Map(data.locations.map((location) => [location.id, { id: location.id, name: location.name }]));
  for (const release of publicationReleases) {
    for (const location of release.locations) {
      if (!directory.has(location.id)) directory.set(location.id, location);
    }
  }
  const editions = data.editions.filter((edition) => directory.has(edition.location_id)
    && Number.isFinite(edition.published_at) && edition.published_at > 0 && edition.published_at <= now)
    .sort((a, b) => b.published_at - a.published_at || a.id.localeCompare(b.id));
  const publishedLocations = new Set([
    ...editions.map((edition) => edition.location_id),
    ...publicationReleases.flatMap((release) => release.locations.map((location) => location.id)),
    ...(data.publicationLocations ?? []).map((location) => location.id),
  ]);
  const locations = [...directory.values()].filter((location) => publishedLocations.has(location.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const selectedLocation = locations.find((location) => location.id === filters.location) ?? null;
  const scoped = editions.filter((edition) => !filters.location || edition.location_id === filters.location);
  const scopedReleases = publicationReleases.filter((release) =>
    !filters.location || release.locations.some((location) => location.id === filters.location));
  const history = [
    ...scoped.map((edition): BrowseEdition => ({
    id: edition.id, locationId: edition.location_id, locationName: directory.get(edition.location_id)!.name,
    locationIds: [edition.location_id],
    headline: edition.headline, windowStart: edition.window_start, windowEnd: edition.window_end,
    publishedAt: edition.published_at, storyCount: edition.items_loaded === false ? null : edition.items.length,
    href: editionHref(base, edition.location_id, edition.id), kind: "legacy",
    publicationName: null, searchable: true, withdrawn: false,
    })),
    ...scopedReleases.map((release): BrowseEdition => ({
      id: release.key,
      locationId: release.locations[0]?.id ?? "",
      locationIds: release.locations.map((location) => location.id),
      locationName: release.locations.map((location) => location.name).join(" · "),
      headline: release.title,
      windowStart: release.window_start,
      windowEnd: release.window_end,
      publishedAt: release.published_at,
      storyCount: release.items?.length ?? null,
      href: publicationReleaseHref(base, release.publication_id, release.release_id),
      kind: "publication",
      publicationName: release.publication_name,
      searchable: release.latest && !release.withdrawn,
      withdrawn: release.withdrawn,
    })),
  ].sort((left, right) => right.publishedAt - left.publishedAt || left.id.localeCompare(right.id));
  const matchingSelection = filters.edition
    ? history.find((edition) => edition.id === filters.edition)
    : null;
  let invalidReason = "";
  if (filters.location && !selectedLocation) invalidReason = "This community has no published editions available.";
  else if (filters.edition && (!filters.location || !matchingSelection)) {
    invalidReason = "This published edition could not be found for the selected community.";
  } else if (matchingSelection && !matchingSelection.searchable) {
    invalidReason = "Older publication releases open from history but are not indexed for story search.";
  } else if (filters.topic && !BROWSE_TOPICS.some((entry) => entry.id === filters.topic)) invalidReason = "Choose one of the listed topics.";

  const historyPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const historyPage = Math.min(filters.historyPage, historyPages);
  const selectedEdition = matchingSelection?.searchable ? matchingSelection : null;
  const editionOptions = history.filter((edition) => edition.searchable).slice(0, EDITION_OPTION_LIMIT);
  if (selectedEdition && !editionOptions.includes(selectedEdition)) editionOptions.push(selectedEdition);

  const versions = new Map<string, StoryVersion[]>();
  if (!invalidReason) for (const edition of scoped) {
    if (filters.edition && edition.id !== filters.edition) continue;
    edition.items.forEach((item, index) => {
      if (!item.headline.trim()) return;
      const topicId = topic(item);
      const key = identity(edition.location_id, item);
      const group = versions.get(key) ?? [];
      if (group.some((version) => version.editionId === edition.id)) return;
      group.push({
        headline: item.headline, summary: item.blurb, eventDate: item.event_date,
        topic: topicId, topicLabel: BROWSE_TOPICS.find((entry) => entry.id === topicId)!.label,
        locationId: edition.location_id, locationName: directory.get(edition.location_id)!.name,
        editionId: edition.id, publishedAt: edition.published_at,
        editionHref: editionHref(base, edition.location_id, edition.id),
        href: publishedStoryHref(base, edition, item, index),
        rank: item.rank ?? index, identity: key, publicationName: null, kind: "legacy",
      });
      versions.set(key, group);
    });
  }
  if (!invalidReason) for (const release of scopedReleases) {
    if (!release.items || release.withdrawn || filters.edition && release.key !== filters.edition) continue;
    release.items.forEach((item, index) => {
      if (!item.headline.trim()
        || filters.location && item.location_ids.length > 0 && !item.location_ids.includes(filters.location)) return;
      const locationId = item.location_ids[0] ?? release.locations[0]?.id ?? release.publication_id;
      const topicId = topic(item);
      const key = identity(locationId, item, release.publication_id);
      const group = versions.get(key) ?? [];
      if (group.some((version) => version.editionId === release.key)) return;
      group.push({
        headline: item.headline,
        summary: item.blurb,
        eventDate: item.event_date,
        topic: topicId,
        topicLabel: BROWSE_TOPICS.find((entry) => entry.id === topicId)!.label,
        locationId,
        locationName: item.location_names.join(" · ") || release.locations.map((location) => location.name).join(" · "),
        editionId: release.key,
        publishedAt: release.published_at,
        editionHref: publicationReleaseHref(base, release.publication_id, release.release_id),
        href: publicationReleaseHref(base, release.publication_id, release.release_id, item.item_id),
        rank: item.rank ?? index,
        identity: key,
        publicationName: release.publication_name,
        kind: "publication",
      });
      versions.set(key, group);
    });
  }
  const words = fold(filters.q).split(/\s+/).filter(Boolean);
  const results: BrowseStory[] = [];
  for (const group of versions.values()) {
    // Search every version, then show the newest matching version with its exact link.
    group.sort((left, right) => right.publishedAt - left.publishedAt || left.editionId.localeCompare(right.editionId));
    const match = group.find((version) => (!filters.topic || version.topic === filters.topic)
      && words.every((word) => fold(`${version.headline} ${version.summary} ${version.locationName} ${version.publicationName ?? ""}`).includes(word)));
    if (!match) continue;
    const { rank: _rank, identity: _identity, ...publicStory } = match;
    results.push({ ...publicStory, versionCount: group.length,
      otherVersions: group.filter((version) => version !== match).slice(0, VERSION_LINK_LIMIT)
        .map((version) => ({ editionId: version.editionId, publishedAt: version.publishedAt, href: version.href })),
    });
  }
  results.sort((a, b) => b.publishedAt - a.publishedAt || b.eventDate.localeCompare(a.eventDate) || a.headline.localeCompare(b.headline));
  const pages = Math.max(1, Math.ceil(results.length / BROWSE_PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  const hasPublicationReleases = Boolean(selectedLocation && scopedReleases.length);
  return {
    filters: { ...filters, page, historyPage }, invalidReason, locations, selectedLocation, selectedEdition,
    latestHref: selectedLocation
      ? hasPublicationReleases
        ? `${base.replace(/\/$/, "")}/locations/${encodeURIComponent(selectedLocation.id)}`
        : editionHref(base, selectedLocation.id)
      : base || "/",
    latestLabel: hasPublicationReleases ? "Browse latest publications" : `Read the latest ${selectedLocation?.name.split(",")[0] ?? ""} edition`,
    editionOptions, history: history.slice((historyPage - 1) * HISTORY_PAGE_SIZE, historyPage * HISTORY_PAGE_SIZE),
    historyTotal: history.length, historyPage, historyPages,
    stories: results.slice((page - 1) * BROWSE_PAGE_SIZE, page * BROWSE_PAGE_SIZE),
    total: results.length, page, pages,
    publicationReleaseCount: scopedReleases.length,
  };
}

export function browseDate(publishedAt: number) {
  return new Date(publishedAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
}
