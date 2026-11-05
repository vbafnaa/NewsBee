import type { Db } from "mongodb";
import type { Settings } from "../core/config";
import type { HttpTransport } from "../core/http";
import type { Logger } from "../core/log";
import type { LookupRanges } from "../core/time";
import type { ModelRuntime } from "../model/runtime";
import type { EventFacts } from "./common";
import type { Fetcher } from "./fetcher";
import type { Community } from "../../../../shared/community-directory";
import type { Story } from "../editions/stories";

/** Source types the orchestrator can run. Each must be registered in registry.ts (checked by the compiler). */
export type SourceType = "library" | "meetings" | "hazards" | "trending" | "homesafety" | "housing" | "remembrance" | "justice" | "community" | "web" | "opendata" | "newssearch" | "sweep" | "property";

export type LibraryBranch = { name: string; address: string; latitude?: number | null; longitude?: number | null };

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
  /** Set when a map run finishes. */
  source_map_at?: number;
  source_map_version?: number;
  community?: Community;
  source_coverage?: { status: "ready" | "partial" | "no_local_sources"; area: string; gaps: string[]; discovery_gaps?: string[]; checked_at: string };
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
  link_discovery?: { method: "rules" | "ai" | "cache" | "search"; detail?: string };
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

/** An item a reader saw but did not keep, with the reason; shown on the edition map. */
export type DroppedItem = { source_event_id: string; title: string; url: string | null; reason: string; event_date?: string | null };

export type CollectedSource = { result: SourceResult; events: CollectedEvent[]; dropped?: DroppedItem[] };

/** Links a connector discovered for a source, reused until the source fails or finds nothing. */
export type CachedLinks = {
  source_id: string;
  location_id: string;
  kind: string;
  url: string;
  page?: string | null;
  method: "rules" | "ai" | "search";
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
  /** The edition's upcoming window: inclusive [tomorrow, tomorrow + 6] YYYY-MM-DD. */
  window: [string, string];
  /**
   * This connector's lookup ranges, from its window and the location's last edition.
   * Absent outside a pipeline run (tests, manual-link checks): read it with rangesFor().
   */
  range?: LookupRanges;
  transport: HttpTransport;
  fetcher: Fetcher;
  settings: Settings;
  db: Db;
  linkCache: LinkCache;
  /** Present only when NEWSBEE_AI_LINK_DISCOVERY is on. */
  model?: ModelRuntime | null;
  /** Agentic runs only: reads pages the readers cannot parse. */
  agentModel?: ModelRuntime | null;
  /** Edition runs read saved addresses only: one that fails is `needs_remap`, for the next map run. */
  readOnly?: boolean;
  /** When this source should stop starting new requests and return what it has (epoch ms). */
  deadline?: number;
  log: Logger;
};

/** A unit of connector work sized for one serverless call. */
export type SourceTask = { source_id: string; name: string; type: SourceType; params?: Record<string, unknown> };

/**
 * How far a connector looks for material, relative to the edition. The orchestrator turns
 * this into concrete date ranges; a connector may look back, ahead, or both.
 */
export type LookupWindow = {
  /** Look back from today: a fixed number of days, or since the location's last published edition (capped). */
  back?: { days: number } | { since: "last_edition"; maxDays: number };
  /** Look ahead from tomorrow, in days. */
  ahead?: { days: number };
};

/** What a connector says about itself; the inventory, coverage note and edition contract read this. */
export type ConnectorMeta = {
  /** Name shown to editors. */
  name: string;
  /** Formats and sources it reads, shown to editors. */
  formats: string;
  /** Editors can add a manual link for this connector. */
  manual: boolean;
  /** Where its coverage is described in the edition's coverage note. */
  coverage: { group: "local" | "wider" | "parents"; label: string };
  /** Story kinds this connector produces; each must be in the edition contract. */
  storyKinds: readonly string[];
};

export type Ranker = (stories: Story[]) => Story[];

/**
 * A source type, described in one place. To add one: build the connector with its meta,
 * window and ranker, add its type to SourceType, and register it in registry.ts.
 */
export interface Connector {
  type: SourceType;
  meta: ConnectorMeta;
  window: LookupWindow;
  /** A window that depends on the task (an open-data topic); defaults to `window`. */
  windowFor?(task: SourceTask): LookupWindow;
  /** Orders this connector's stories before authoring shortlists them. */
  rank?: Ranker;
  /** The sources this connector would run for a location (empty when not applicable). */
  sources(location: LocationProfile, settings: Settings): SourceTask[];
  /**
   * Ordinary source problems become a failed SourceResult. Transient errors (network,
   * HTTP 429/5xx) may throw so the job queue retries, matching Stage 1.
   */
  collect(task: SourceTask, context: ConnectorContext): Promise<CollectedSource>;
}
