/**
 * MongoDB access for the pipeline. Local development points MONGODB_URI at the local MongoDB
 * started by `npm run local:mongo`; tests inject an in-memory database with useDatabase().
 */
import { type Db, MongoClient } from "mongodb";
import { fencedDatabase } from "../../../../shared/restore-maintenance";

type MongoCache = typeof globalThis & {
  newsbeePipelineMongo?: { uri: string; client: MongoClient; promise?: Promise<MongoClient> };
  newsbeePipelineTestDb?: Db | null;
};

const state = globalThis as MongoCache;

export function useDatabase(database: Db | null) {
  state.newsbeePipelineTestDb = database;
}

export async function getDatabase(): Promise<Db> {
  if (state.newsbeePipelineTestDb) return fencedDatabase(state.newsbeePipelineTestDb);
  const uri = process.env.MONGODB_URI;
  const name = process.env.MONGODB_DATABASE;
  if (!uri) throw new Error("MONGODB_URI is not configured");
  if (!name) throw new Error("MONGODB_DATABASE is not configured");
  if (!state.newsbeePipelineMongo || state.newsbeePipelineMongo.uri !== uri) {
    state.newsbeePipelineMongo = { uri, client: new MongoClient(uri) };
  }
  const mongo = state.newsbeePipelineMongo;
  mongo.promise ??= mongo.client.connect().catch((error: unknown) => {
    mongo.promise = undefined;
    throw error;
  });
  return fencedDatabase((await mongo.promise).db(name));
}

/** Every pipeline collection, in one place so storage can be audited and swapped. */
export const COLLECTIONS = {
  places: "census_places",
  directorySetup: "directory_setup",
  libraryOutlets: "library_outlets",
  schoolDistricts: "school_districts",
  locations: "locations",
  linkCache: "connector_link_cache",
  manualLinks: "location_source_links",
  jobs: "pipeline_jobs",
  runs: "pipeline_runs",
  sourceResults: "source_results",
  shortlists: "source_shortlists",
  editions: "editions",
  editionEntries: "edition_entries",
  publishedStories: "published_stories",
  storyCache: "story_cache",
  withdrawals: "withdrawals",
  wideCache: "wider_source_cache",
  heartbeat: "pipeline_heartbeat",
  modelUsage: "model_usage",
  readerDataClears: "reader_data_clears",
  videoPackages: "video_production_packages",
  videoJobs: "video_production_jobs",
  videoUploadSessions: "video_upload_sessions",
  videoUploadChunks: "video_upload_chunks",
  youtubeLocationSettings: "youtube_location_settings",
  outputChannels: "output_channels",
  outputChannelCreations: "output_channel_creations",
  outputChannelEditions: "output_channel_editions",
  outputChannelFiles: "output_channel_files",
  publicationAccessAudit: "publication_access_audit",
  accessPolicyAudit: "access_policy_audit",
  publicationGenerations: "publication_generations",
  publicationDrafts: "publication_drafts",
  publicationReleaseActions: "publication_release_actions",
  publicationInterviewNotes: "publication_interview_notes",
  publicationImages: "publication_images",
  publicationEmailSubscriptions: "publication_email_subscriptions",
  publicationEmailLimits: "publication_email_limits",
  publicationEmailConsents: "publication_email_consents",
  publicationEmailSuppressions: "publication_email_suppressions",
  publicationEmailEvents: "publication_email_events",
  publicationEmailCampaigns: "publication_email_campaigns",
  publicationEmailDeliveries: "publication_email_deliveries",
  publicationEmailAttempts: "publication_email_attempts",
  publicationEmailOutbox: "publication_email_outbox",
  campaignSignups: "campaign_signups",
} as const;
