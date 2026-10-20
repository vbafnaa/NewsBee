import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import type { HttpTransport } from "../core/http";
import type { Logger } from "../core/log";
import type { ModelRuntime } from "../model/runtime";
import type { EventFacts } from "./common";
import type { Fetcher } from "./fetcher";

/** Source types the orchestrator can run; each has its own connector and per-source ranker. */
export type SourceType = "library" | "meetings" | "hazards" | "statenews" | "trending";
export const SOURCE_TYPES: readonly SourceType[] = ["library", "meetings", "hazards", "statenews", "trending"];

export type LibraryBranch = { name: string; address: string };

export type WebsiteLookup = {
  status: string;
  website: string | null;
  wikidata_id: string | null;
  detail: string;
};

export type LibrarySystem = {
  fscskey: string;
  name: string;
  latitude?: string | number | null;
  longitude?: string | number | null;
  branches: LibraryBranch[];
  website?: string | null;
  website_lookup?: WebsiteLookup;
};

export type GovernmentSource = {
  status: string;
  platform: string | null;
  tenant: string | null;
  website: string | null;
  wikidata_id: string | null;
  pages_checked: string[];
  detail: string;
};

/** An onboarded location, as Stage 1's profile plus the Census place it came from. */
export type LocationProfile = {
  id: string;
  name: string;
  state: string;
  census_geoid?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  directory_edition?: string | null;
  systems: LibrarySystem[];
  government?: GovernmentSource | null;
  onboarded_at?: string;
};

/** The per-source ingestion record every collector returns (Python SystemIngestion). */
export type SourceResult = {
  source_id: string;
  name: string;
  website: string | null;
  status: string;
  detail: string;
  feed_kind: string | null;
  feed_url: string | null;
  pages_checked: string[];
  response_sha256: string | null;
  event_count: number;
  skipped_other_venues: number;
  skipped_outside_window: number;
  skipped_unusable: Record<string, number>;
  unmatched_venues: Record<string, number>;
  link_discovery?: { method: "rules" | "ai" | "cache"; detail?: string };
  [extra: string]: unknown;
};

export function sourceResult(
  sourceId: string,
  name: string,
  status: string,
  detail: string,
  values: Partial<SourceResult> = {},
): SourceResult {
  return {
    source_id: sourceId,
    name,
    website: null,
    status,
    detail,
    feed_kind: null,
    feed_url: null,
    pages_checked: [],
    response_sha256: null,
    event_count: 0,
    skipped_other_venues: 0,
    skipped_outside_window: 0,
    skipped_unusable: {},
    unmatched_venues: {},
    ...values,
  };
}

/** One retained event with every connector-specific fact (branch, kind, tier, body...). */
export type CollectedEvent = EventFacts & Record<string, unknown>;

export type CollectedSource = { result: SourceResult; events: CollectedEvent[] };

/** Links a connector discovered for a source, reused until the source fails or finds nothing. */
export type CachedLinks = {
  source_id: string;
  location_id: string;
  kind: string;
  url: string;
  page?: string | null;
  method: "rules" | "ai";
  discovered_at: string;
};

export interface LinkCache {
  get(locationId: string, sourceId: string): Promise<CachedLinks | null>;
  put(entry: Omit<CachedLinks, "discovered_at">): Promise<void>;
  invalidate(locationId: string, sourceId?: string): Promise<void>;
}

export type ConnectorContext = {
  location: LocationProfile;
  /** Today in the location's calendar, YYYY-MM-DD. */
  today: string;
  /** Inclusive [start, end] YYYY-MM-DD ingest window (tomorrow + 7 days). */
  window: [string, string];
  transport: HttpTransport;
  fetcher: Fetcher;
  settings: Settings;
  db: Db;
  linkCache: LinkCache;
  /** Present only when NEWSBEE_AI_LINK_DISCOVERY is on. */
  model?: ModelRuntime | null;
  log: Logger;
};

/** A unit of connector work sized for one serverless call. */
export type SourceTask = { source_id: string; name: string; type: SourceType; params?: Record<string, unknown> };

export interface Connector {
  type: SourceType;
  /** The sources this connector would run for a location (empty when not applicable). */
  sources(location: LocationProfile, settings: Settings): SourceTask[];
  /**
   * Ordinary source problems become a failed SourceResult. Transient errors (network,
   * HTTP 429/5xx) may throw so the job queue retries, matching Stage 1.
   */
  collect(task: SourceTask, context: ConnectorContext): Promise<CollectedSource>;
}
