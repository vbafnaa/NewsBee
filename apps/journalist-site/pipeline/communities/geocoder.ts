import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { COMMUNITY_USER_AGENT, GEOGRAPHIC_PLACES, parsePhoton, type GeographicPlace } from "../../../../shared/geography";
import { fetchTransport, HttpStatusError, json, type HttpTransport } from "../core/http";
import { logger } from "../core/log";

export type GeographicDocument = GeographicPlace & { _id: string; name_lower: string; fetched_at: number };
type SearchCache = { _id: string; results: string[]; expires_at: Date };
type Lease = { _id: string; owner?: string; expires_at: number };
const CACHE = "geographic_search_cache", LEASES = "geographic_search_leases";
const log = logger("communities.geocoder");

async function cachedPlaces(db: Db, key: string) {
  const cached = await db.collection<SearchCache>(CACHE).findOne({ _id: key, expires_at: { $gt: new Date() } });
  if (!cached) return null;
  const docs = await db.collection<GeographicDocument>(GEOGRAPHIC_PLACES).find({ _id: { $in: cached.results } }).toArray();
  if (docs.length !== cached.results.length) {
    log.warn("geographic_cache_incomplete", { expected: cached.results.length, actual: docs.length });
    return null;
  }
  return cached.results.map((id) => docs.find((item) => item._id === id)!);
}

/** Explicit searches only: shared throttle/cache limit traffic across serverless instances. */
export async function searchGeography(db: Db, query: string, transport: HttpTransport = fetchTransport): Promise<GeographicPlace[]> {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (normalized.length < 2) return [];
  if (normalized.length > 80) throw new Error("Geographic search is limited to 80 characters");
  const url = new URL(process.env.NEWSBEE_GEOCODER_URL ?? "https://photon.komoot.io/api/");
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("NEWSBEE_GEOCODER_URL must be an HTTPS Photon API URL without credentials");
  url.searchParams.set("q", normalized);
  url.searchParams.set("lang", "en");
  url.searchParams.set("limit", "20");
  url.searchParams.set("countrycode", "US");
  url.searchParams.append("layer", "district");
  url.searchParams.append("layer", "locality");
  url.searchParams.append("layer", "city");
  const key = createHash("sha256").update(url.toString().toLowerCase()).digest("hex");
  await db.collection<SearchCache>(CACHE).createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  const places = db.collection<GeographicDocument>(GEOGRAPHIC_PLACES);
  const cached = await cachedPlaces(db, key);
  if (cached) return cached;
  const leases = db.collection<Lease>(LEASES);
  const owner = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 12 && !acquired; attempt++) {
    try {
      const lease = await leases.findOneAndUpdate(
        { _id: "provider", expires_at: { $lte: Date.now() } },
        { $set: { owner, expires_at: Date.now() + 20_000 } }, { upsert: true, returnDocument: "after" },
      );
      acquired = lease?.owner === owner;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === 11000)) throw error;
    }
    if (!acquired) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!acquired) throw new Error("Geographic search is busy. Please retry in a few seconds.");
  try {
    // A concurrent identical request may have filled the cache while we waited.
    const ready = await cachedPlaces(db, key);
    if (ready) return ready;
    const response = await transport({ url: url.toString(), headers: { "User-Agent": COMMUNITY_USER_AGENT, Accept: "application/json" }, maxBytes: 2 * 1024 * 1024, timeoutMs: 12_000 });
    if (response.status >= 300) throw new HttpStatusError(response.status, url.origin);
    const results = parsePhoton(json(response));
    for (const place of results) {
      await places.replaceOne({ _id: place.id }, { ...place, name_lower: place.name.toLowerCase(), fetched_at: Date.now() }, { upsert: true });
    }
    await db.collection<SearchCache>(CACHE).replaceOne({ _id: key }, {
      results: results.map((place) => place.id), expires_at: new Date(Date.now() + (results.length ? 7 * 86400_000 : 3600_000)),
    }, { upsert: true });
    log.info("geographic_search_completed", { results: results.length, provider: url.hostname });
    return results;
  } finally {
    await leases.updateOne({ _id: "provider", owner }, { $set: { expires_at: Date.now() + 1100 }, $unset: { owner: "" } });
  }
}
