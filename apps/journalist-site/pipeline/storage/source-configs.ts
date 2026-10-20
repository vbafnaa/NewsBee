/**
 * Reviewed source configs and the community directory live in
 * MongoDB `source_configs` so admins can edit them. On first use each one is seeded from
 * the repo's config/<name>.json (bundled at build time, so seeding also works on Vercel).
 */
import type { Db } from "mongodb";
import governmentSources from "../../../../config/government-sources.json";
import libraryWebsites from "../../../../config/library-websites.json";
import stateSources from "../../../../config/state-sources.json";
import { COMMUNITY_SEED } from "../../../../shared/community-directory";

export const SOURCE_CONFIGS = ["library-websites", "government-sources", "state-sources", "communities"] as const;
export type SourceConfigName = (typeof SOURCE_CONFIGS)[number];

type SourceConfigDocument = { _id: string; config_path: string; data: Record<string, unknown> };

const SEEDS: Record<SourceConfigName, Record<string, unknown>> = {
  "library-websites": libraryWebsites as Record<string, unknown>,
  "government-sources": governmentSources as Record<string, unknown>,
  "state-sources": stateSources as Record<string, unknown>,
  "communities": COMMUNITY_SEED,
};

/** The config's `data` object; seeds MongoDB from the reviewed repo file when missing. */
export async function loadSourceConfig(db: Db, _root: string, name: SourceConfigName): Promise<Record<string, unknown>> {
  const collection = db.collection<SourceConfigDocument>("source_configs");
  const existing = await collection.findOne({ _id: name });
  if (existing && typeof existing.data === "object" && existing.data !== null) return existing.data;
  const data = structuredClone(SEEDS[name]);
  await collection.updateOne(
    { _id: name },
    { $setOnInsert: { config_path: `config/${name}.json`, data } },
    { upsert: true },
  );
  return ((await collection.findOne({ _id: name }))?.data ?? data) as Record<string, unknown>;
}
