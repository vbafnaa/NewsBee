/**
 * MongoDB access for the pipeline. Local development points MONGODB_URI at the local MongoDB
 * started by `npm run local:mongo`; tests inject an in-memory database with useDatabase().
 */
import { type Db, MongoClient } from "mongodb";

type MongoCache = typeof globalThis & {
  newsbeePipelineMongo?: { uri: string; client: MongoClient; promise?: Promise<MongoClient> };
  newsbeePipelineTestDb?: Db | null;
};

const state = globalThis as MongoCache;

export function useDatabase(database: Db | null) {
  state.newsbeePipelineTestDb = database;
}

export async function getDatabase(): Promise<Db> {
  if (state.newsbeePipelineTestDb) return state.newsbeePipelineTestDb;
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
  return (await mongo.promise).db(name);
}

/** Every pipeline collection, in one place so storage can be audited and swapped. */
export const COLLECTIONS = {
  places: "census_places",
  libraryOutlets: "library_outlets",
  locations: "locations",
  linkCache: "connector_link_cache",
  jobs: "pipeline_jobs",
  runs: "pipeline_runs",
  sourceResults: "source_results",
  shortlists: "source_shortlists",
  editions: "editions",
  editionEntries: "edition_entries",
  storyCache: "story_cache",
  withdrawals: "withdrawals",
  wideCache: "wider_source_cache",
  outputChannels: "output_channels",
  heartbeat: "pipeline_heartbeat",
} as const;
