import type { Db } from "mongodb";
import type { HttpTransport } from "../core/http";
import type { Settings } from "../core/config";
import type { GovernmentSource, LocationProfile, LibrarySystem } from "../connectors/types";
import { COLLECTIONS } from "../storage/mongo";
import { loadSourceConfig } from "../storage/source-configs";
import { logger } from "../core/log";
import { ACTIVE_RUN_STATUSES } from "../orchestration/runs";
import { channels, ensureReaderChannel } from "../orchestration/publish";
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
export type WebsiteOverride = { name: string; website: string };
export type OnboardOptions = {
  discoveryGaps?: string[];
  settings?: Pick<Settings, "root">;
  overrides?: Record<string, WebsiteOverride>;
  discoverGovernment?: (profile: LocationProfile) => Promise<GovernmentSource>;
  discoverNews?: typeof discoverCommunityNews;
};

export function websiteOverrides(data: Record<string, unknown>): Record<string, WebsiteOverride> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("library-websites.json must map FSCS keys to {name, website}");
  const result: Record<string, WebsiteOverride> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`library-websites.json entry ${key} needs a name and an https:// website`);
    const entry = value as Record<string, unknown>;
    const website = typeof entry.website === "string" ? entry.website : "";
    const origin = httpsOrigin(website);
    if (typeof entry.name !== "string" || !entry.name || !website.startsWith("https://") || !origin) throw new Error(`library-websites.json entry ${key} needs a name and an https:// website`);
    result[key] = { name: entry.name, website: origin };
  }
  return result;
}
function overrideLookup(system: LibrarySystem, entry: WebsiteOverride) {
  if (entry.name.toLowerCase() !== system.name.toLowerCase()) throw new Error(`library-websites.json entry ${system.fscskey} is named ${JSON.stringify(entry.name)}, but the directory lists ${JSON.stringify(system.name)}`);
  return { status: "override", website: entry.website, wikidata_id: null, detail: "Website from config/library-websites.json" };
}

export async function getLocation(db: Db, id: string): Promise<LocationProfile> {
  const profile = await db.collection<LocationDocument>(COLLECTIONS.locations).findOne({ _id: id });
  if (!profile) throw new Error(`Location is not onboarded: ${id}`);
  const { _id: _ignored, ...result } = profile;
  if (result.community) {
    const manual = await db.collection(COLLECTIONS.manualLinks).find({ location_id: id }).project<{ connector: string }>({ connector: 1 }).toArray();
    result.source_coverage = sourceCoverage(result, result.source_coverage?.discovery_gaps, manual.map((link) => link.connector));
  }
  return result as LocationProfile;
}

export async function listLocations(db: Db): Promise<LocationProfile[]> {
  const docs = await db.collection<LocationProfile & { _id: string }>(COLLECTIONS.locations).find({}).sort({ name: 1 }).toArray();
  return Promise.all(docs.map(async ({ _id: _ignored, ...profile }) => profile.community ? getLocation(db, profile.id) : profile));
}

export async function onboardLocation(db: Db, transport: HttpTransport, placeIdentity: string, options: OnboardOptions = {}): Promise<LocationProfile> {
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
  const overrideData = options.overrides ?? await loadSourceConfig(db, options.settings?.root ?? process.cwd(), "library-websites");
  const overrides = websiteOverrides(overrideData as Record<string, unknown>);
  for (const system of profile.systems) {
    const entry = overrides[system.fscskey];
    let lookup;
    try {
      lookup = entry ? overrideLookup(system, entry) : await lookupWebsite(transport, system.name, system.latitude == null ? null : Number(system.latitude), system.longitude == null ? null : Number(system.longitude));
    } catch (error) {
      if (!geographic || entry) throw error;
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
  if (!existing) await ensureReaderChannel(db);
  const saved = await db.collection<LocationDocument>(COLLECTIONS.locations).replaceOne({ _id: placeIdentity }, { ...profile, _id: placeIdentity }, { upsert: true });
  if (saved.upsertedCount) {
    await channels(db).updateOne({ _id: "reader-site" }, { $addToSet: { selected_location_ids: placeIdentity } });
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
  await db.collection<LocationDocument>(COLLECTIONS.locations).replaceOne({ _id: id }, { ...profile, _id: id }, { upsert: false });
  log.info("location_sources_updated", { location_id: id });
  return profile;
}

export class LocationBusy extends Error {}
const LOCATION_COLLECTIONS = [
  ["manual_links", COLLECTIONS.manualLinks],
  ["link_cache", COLLECTIONS.linkCache], ["jobs", COLLECTIONS.jobs], ["runs", COLLECTIONS.runs],
  ["source_results", COLLECTIONS.sourceResults], ["source_shortlists", COLLECTIONS.shortlists],
  ["editions", COLLECTIONS.editions], ["edition_entries", COLLECTIONS.editionEntries],
  ["story_cache", COLLECTIONS.storyCache], ["withdrawals", COLLECTIONS.withdrawals],
] as const;

export async function removeLocation(db: Db, id: string): Promise<Record<string, number>> {
  await getLocation(db, id);
  const running = await db.collection<LocationRef>(COLLECTIONS.jobs).countDocuments({ location_id: id, status: "running" });
  if (running) throw new LocationBusy(`${id} has a running job; wait for it to finish`);
  const active = await db.collection(COLLECTIONS.runs).countDocuments({ location_id: id, status: { $in: ACTIVE_RUN_STATUSES } });
  if (active) throw new LocationBusy(`${id} has an active run; cancel it before removal`);
  const counts: Record<string, number> = {};
  for (const [name, collectionName] of LOCATION_COLLECTIONS) {
    const result = await db.collection<LocationRef>(collectionName).deleteMany({ location_id: id });
    counts[name] = result.deletedCount;
  }
  counts.locations = (await db.collection<LocationDocument>(COLLECTIONS.locations).deleteOne({ _id: id })).deletedCount;
  log.info("location_removed", { location_id: id, counts });
  return counts;
}
