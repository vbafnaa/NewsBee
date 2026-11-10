import type { Db } from "mongodb";
import type { HttpTransport } from "../core/http";
import type { Settings } from "../core/config";
import type { GovernmentSource, LocationProfile, LibrarySystem } from "../connectors/types";
import { COLLECTIONS } from "../storage/mongo";
import { logger } from "../core/log";
import { ACTIVE_RUN_STATUSES } from "../orchestration/runs";
const log = logger("communities.locations");
import { loadCommunities, placeId, systemsForPlace, systemsInArea, type Place } from "./directory";
import { communityName } from "../../../../shared/community-directory";
import { lookupWebsite, httpsOrigin } from "./wikidata";
import { nameKey } from "./venues";
import { GEOGRAPHIC_PLACES } from "../../../../shared/geography";
import type { GeographicDocument } from "./geocoder";
import { sourceCoverage } from "./source-coverage";
import { discoverCommunityNews } from "./news-discovery";

type LocationDocument = LocationProfile & { _id: string; [key: string]: any };
type LocationRef = { _id?: string; location_id: string; status?: string; [key: string]: any };

export const MANAGED_SOURCE_DETAIL = "Managed in Journalist site";
export const DISABLED_GOVERNMENT_DETAIL = "Disabled in Journalist site";
export type OnboardOptions = {
  discoveryGaps?: string[];
  settings?: Pick<Settings, "root">;
  discoverGovernment?: (profile: LocationProfile) => Promise<GovernmentSource>;
  discoverNews?: typeof discoverCommunityNews;
};

export async function getLocation(db: Db, id: string, allowRemoval = false): Promise<LocationProfile> {
  const profile = await db.collection<LocationDocument>(COLLECTIONS.locations).findOne({ _id: id });
  if (!profile) throw new Error(`Location is not onboarded: ${id}`);
  return profileFromDocument(db, profile, allowRemoval);
}

async function profileFromDocument(db: Db, profile: LocationDocument, allowRemoval: boolean): Promise<LocationProfile> {
  if (profile.removal && !allowRemoval) throw new LocationBusy(`${profile.id} is being removed; retry cleanup in Location details`);
  const { _id: _ignored, removal, ...result } = profile;
  if (removal) result.removal_pending = true;
  if (result.community) {
    const manual = await db.collection(COLLECTIONS.manualLinks).find({ location_id: profile.id }).project<{ connector: string }>({ connector: 1 }).toArray();
    result.source_coverage = sourceCoverage(result, result.source_coverage?.discovery_gaps, manual.map((link) => link.connector));
  }
  return result as LocationProfile;
}

export async function listLocations(db: Db): Promise<LocationProfile[]> {
  const docs = await db.collection<LocationDocument>(COLLECTIONS.locations).find({}).sort({ name: 1 }).toArray();
  return Promise.all(docs.map((profile) => profileFromDocument(db, profile, true)));
}

export async function onboardLocation(db: Db, transport: HttpTransport, placeIdentity: string, options: OnboardOptions = {}): Promise<LocationProfile> {
  const initial = await db.collection<LocationDocument>(COLLECTIONS.locations).findOne({ _id: placeIdentity });
  if (initial?.removal) {
    throw new LocationBusy(`${placeIdentity} has pending removal; finish cleanup before onboarding again`);
  }
  const catalog = await loadCommunities(db);
  const geographic = await db.collection<GeographicDocument>(GEOGRAPHIC_PLACES).findOne({ _id: placeIdentity });
  const reviewed = geographic ? Object.values(catalog).find((entry) => entry.name.toLowerCase() === geographic.name.toLowerCase()
    && entry.state === geographic.state && entry.parent_name.toLowerCase() === geographic.parent_name?.toLowerCase()) : catalog[placeIdentity];
  const community = geographic ? {
    name: geographic.name, state: geographic.state, state_name: geographic.state_name,
    parent_id: placeId(geographic.parent_name ?? geographic.name, geographic.state), parent_name: geographic.parent_name ?? geographic.name,
    parent_kind: geographic.parent_kind, latitude: geographic.latitude, longitude: geographic.longitude,
    aliases: reviewed?.aliases ?? [], coverage_terms: reviewed?.coverage_terms ?? [geographic.name],
    library_branches: reviewed?.library_branches ?? [], newsrooms: reviewed?.newsrooms ?? [], geography: geographic,
  } : reviewed;
  const place = await db.collection<Place>(COLLECTIONS.places).findOne({ _id: community?.parent_id ?? placeIdentity });
  if (!place && !geographic) throw new Error(`Census place is not available: ${community?.parent_id ?? placeIdentity}`);
  if (!geographic && community && place && (community.state !== place.state || community.parent_name.toLowerCase() !== place.name.toLowerCase())) {
    throw new Error(`Community ${placeIdentity} parent does not match Census place ${place._id}`);
  }
  const { systems, edition } = geographic && !reviewed ? await systemsInArea(db, geographic)
    : await systemsForPlace(db, place?._id ?? community!.parent_id, community?.library_branches);
  const gaps = [...(options.discoveryGaps ?? [])];
  if (community && reviewed) {
    const missing = community.library_branches.filter((name) => !systems.some((system) => system.branches.some((branch) => nameKey(branch.name) === nameKey(name))));
    if (missing.length) gaps.push(`Configured library branches missing from the directory: ${missing.join(", ")}. No citywide fallback was applied.`);
  }
  const profile: LocationProfile = {
    id: placeIdentity,
    name: geographic?.label ?? (community ? communityName(community) : `${place!.name}, ${place!.state}`),
    state: community?.state ?? place!.state,
    census_geoid: community ? null : place!.geoid,
    latitude: community?.latitude ?? place!.latitude,
    longitude: community?.longitude ?? place!.longitude,
    directory_edition: `IMLS PLS ${edition}`,
    systems,
    government: null,
    ...(community ? { community } : {}),
  };
  if (community && geographic) {
    const discovered = await (options.discoverNews ?? discoverCommunityNews)(transport, community);
    community.newsrooms = discovered.newsrooms;
    community.library_branches = systems.flatMap((system) => system.branches.map((branch) => branch.name));
    gaps.push(...discovered.gaps);
  }
  for (const system of profile.systems) {
    let lookup;
    try {
      lookup = await lookupWebsite(transport, system.name, system.latitude == null ? null : Number(system.latitude), system.longitude == null ? null : Number(system.longitude));
    } catch (error) {
      if (!geographic) throw error;
      const detail = `Library website discovery unavailable: ${error instanceof Error ? error.message : String(error)}`;
      log.warn("library_discovery_unavailable", { location_id: placeIdentity, detail });
      gaps.push(detail);
      lookup = { status: "unresolved", website: null, wikidata_id: null, detail };
    }
    system.website_lookup = lookup;
    system.website = lookup.website;
    log.info("library_system_onboarded", { location_id: placeIdentity, fscskey: system.fscskey, website_status: lookup.status, detail: lookup.detail });
  }
  if (options.discoverGovernment) {
    try {
      profile.government = geographic && !geographic.parent_kind ? {
        status: "unresolved_website", platform: null, tenant: null, website: null, wikidata_id: null, pages_checked: [],
        detail: "Geocoder has no governing city or county; configure a meeting tenant in Sources.",
      } : await options.discoverGovernment(profile);
    } catch (error) {
      if (!geographic) throw error;
      const detail = `Government discovery unavailable: ${error instanceof Error ? error.message : String(error)}`;
      log.warn("government_discovery_unavailable", { location_id: placeIdentity, detail });
      gaps.push(detail);
      profile.government = { status: "unresolved_website", platform: null, tenant: null, website: null, wikidata_id: null, pages_checked: [], detail };
    }
    log.info("government_source_onboarded", { location_id: placeIdentity, status: profile.government.status, platform: profile.government.platform, tenant: profile.government.tenant, detail: profile.government.detail });
  }
  const existing = await db.collection<LocationProfile & { _id: string }>(COLLECTIONS.locations).findOne({ _id: placeIdentity });
  if (existing) {
    const previous = existing as unknown as LocationProfile;
    const oldSystems = new Map((previous.systems ?? []).map((system) => [system.fscskey, system]));
    for (const system of profile.systems) {
      const old = oldSystems.get(system.fscskey);
      if (old?.website_lookup?.detail === MANAGED_SOURCE_DETAIL) {
        system.website = old.website;
        system.website_lookup = old.website_lookup;
      }
    }
    const oldGovernment = previous.government;
    if (oldGovernment?.detail === MANAGED_SOURCE_DETAIL || oldGovernment?.detail === DISABLED_GOVERNMENT_DETAIL) profile.government = oldGovernment;
  }
  if (profile.community) profile.source_coverage = sourceCoverage(profile, gaps);
  try {
    const saved = await db.collection<LocationDocument>(COLLECTIONS.locations).replaceOne(
      { _id: placeIdentity, removal: { $exists: false } }, { ...profile, _id: placeIdentity }, { upsert: !initial },
    );
    if (initial && !saved.matchedCount) throw new LocationBusy(`${placeIdentity} changed during onboarding; reload its cleanup state`);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new LocationBusy(`${placeIdentity} changed during onboarding; reload its cleanup state`);
    throw error;
  }
  log.info("location_onboarded", { location_id: placeIdentity, systems: profile.systems.length });
  return profile;
}

export async function updateSources(db: Db, id: string, websites: Record<string, string | null>, government: { platform: string; tenant: string } | null): Promise<LocationProfile> {
  const profile = await getLocation(db, id);
  const systems = new Map(profile.systems.map((system) => [system.fscskey, system]));
  if (systems.size !== Object.keys(websites).length || [...systems.keys()].some((key) => !Object.prototype.hasOwnProperty.call(websites, key))) {
    throw new Error("Source settings must include exactly the location's library systems");
  }
  for (const [key, system] of systems) {
    const website = websites[key];
    system.website = website;
    system.website_lookup = { status: website ? "override" : "unresolved_website", website, wikidata_id: null, detail: MANAGED_SOURCE_DETAIL };
  }
  profile.government = government ? {
    status: "override", platform: government.platform, tenant: government.tenant, website: null, wikidata_id: null,
    pages_checked: [], detail: MANAGED_SOURCE_DETAIL,
  } : {
    status: "no_platform", platform: null, tenant: null, website: null, wikidata_id: null,
    pages_checked: [], detail: DISABLED_GOVERNMENT_DETAIL,
  };
  if (profile.community) profile.source_coverage = sourceCoverage(profile, profile.source_coverage?.discovery_gaps);
  const saved = await db.collection<LocationDocument>(COLLECTIONS.locations).replaceOne({ _id: id, removal: { $exists: false } }, { ...profile, _id: id }, { upsert: false });
  if (!saved.matchedCount) throw new LocationBusy(`${id} changed while saving sources; reload its cleanup state`);
  log.info("location_sources_updated", { location_id: id });
  return profile;
}

export class LocationBusy extends Error {}
const LOCATION_COLLECTIONS = [
  ["manual_links", COLLECTIONS.manualLinks],
  ["link_cache", COLLECTIONS.linkCache], ["jobs", COLLECTIONS.jobs], ["runs", COLLECTIONS.runs],
  ["source_results", COLLECTIONS.sourceResults], ["source_shortlists", COLLECTIONS.shortlists],
  ["editions", COLLECTIONS.editions], ["edition_entries", COLLECTIONS.editionEntries],
  ["video_packages", COLLECTIONS.videoPackages], ["video_jobs", COLLECTIONS.videoJobs],
  ["youtube_location_settings", COLLECTIONS.youtubeLocationSettings],
  ["story_cache", COLLECTIONS.storyCache], ["withdrawals", COLLECTIONS.withdrawals],
  ["source_map", "source_map"], ["discovery_state", "discovery_state"], ["collected_items", "collected_items"],
  ["edition_maps", "edition_maps"], ["news_publishers", "news_publishers"], ["source_suggestions", "source_suggestions"],
  ["photo_catalog_sources", "photo_catalog_sources"], ["photo_catalog_cache", "photo_catalog_cache"],
  ["photo_supply_invites", "photo_supply_invites"], ["photo_supply_submissions", "photo_supply_submissions"],
  ["edition_photo_claims", "edition_photo_claims"],
] as const;

export async function assertLocationIdle(db: Db, id: string) {
  const running = await db.collection<LocationRef>(COLLECTIONS.jobs).countDocuments({ location_id: id, status: "running" });
  if (running) throw new LocationBusy(`${id} has a running job; wait for it to finish`);
  const active = await db.collection(COLLECTIONS.runs).countDocuments({ location_id: id, status: { $in: ACTIVE_RUN_STATUSES } });
  if (active) throw new LocationBusy(`${id} has an active run; cancel it before removal`);
  const activeVideos = await db.collection(COLLECTIONS.videoJobs).countDocuments({
    location_id: id,
    $or: [
      { status: { $in: ["submitting", "queued", "processing"] } },
      { status: "uploading", updated_at: { $gte: Date.now() - 10 * 60_000 } },
    ],
  });
  if (activeVideos) throw new LocationBusy(`${id} has an active video generation; wait for it to finish before removal`);
}

export async function removeLocationRecords(db: Db, id: string, editionIds: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  // A test-mode map run's own sources go with its run.
  for (const run of await db.collection<{ _id: string }>(COLLECTIONS.runs).find({ location_id: id, kind: "map" }, { projection: { _id: 1 } }).toArray()) await db.collection(`source_run_${run._id}`).drop().catch(() => undefined);
  for (const [name, collectionName] of LOCATION_COLLECTIONS) {
    const filter = collectionName === COLLECTIONS.editionEntries
      ? { $or: [{ location_id: id }, { location_id: { $exists: false }, edition_id: { $in: editionIds } }] }
      : { location_id: id };
    const result = await db.collection<LocationRef>(collectionName).deleteMany(filter);
    counts[name] = result.deletedCount;
  }
  return counts;
}
