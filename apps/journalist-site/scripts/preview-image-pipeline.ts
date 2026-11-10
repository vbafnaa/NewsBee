/** Inspect image selection in an isolated database without modifying the source edition. */
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getLocation } from "../pipeline/communities/locations";
import { processStoryImage, processStockImage, type ImageResult } from "../pipeline/images/pipeline";
import { stockTopic } from "../pipeline/images/stock";
import { storyImage, storyImages } from "../pipeline/editions/authoring";
import { COLLECTIONS } from "../pipeline/storage/mongo";
import { PHOTO_CATALOG_SOURCES } from "../../../shared/photo-catalog";

const locationId = process.argv[process.argv.indexOf("--location") + 1];
if (!process.argv.includes("--local") || !process.argv.includes("--location") || !locationId || locationId.startsWith("--"))
  throw new Error("Use --local --location <onboarded-location-id>. This preview reads only the local Newsbee database.");
const local = new MongoClient("mongodb://127.0.0.1:27027", { serverSelectionTimeoutMS: 10000 });
let sandbox: MongoMemoryServer | undefined, preview: MongoClient | undefined;
try {
  await local.connect(); const source = local.db("newsbee");
  const location = await getLocation(source, locationId);
  const draft = await source.collection(COLLECTIONS.editions).findOne({ location_id: locationId, status: "published" }, { sort: { published_at: -1 } });
  if (!draft) throw new Error("No published local draft for this location");
  sandbox = await MongoMemoryServer.create(); preview = await MongoClient.connect(sandbox.getUri());
  const db = preview.db("image-preview");
  await db.collection(COLLECTIONS.editions).insertOne({ ...draft, status: "ready" });
  const entries = await source.collection(COLLECTIONS.editionEntries).find({ edition_id: draft.id, disposition: "checks_passed" }).toArray();
  if (entries.length) await db.collection(COLLECTIONS.editionEntries).insertMany(entries);
  const sources = await source.collection("source_map").find({ location_id: locationId }).toArray();
  if (sources.length) await db.collection("source_map").insertMany(sources);
  const catalog = await source.collection(PHOTO_CATALOG_SOURCES).find({ location_id: locationId }).toArray();
  if (catalog.length) await db.collection(PHOTO_CATALOG_SOURCES).insertMany(catalog);
  const results = [];
  const primaryResults = new Map<string, ImageResult>();
  for (const entry of entries) {
    const result = await processStoryImage({ db,
      sourcePhoto: (story) => storyImage({ db }, locationId, story),
      sourcePhotos: (story) => storyImages({ db }, locationId, story) }, String(draft.id), entry.story_id, location);
    primaryResults.set(entry.story_id, result);
    console.log(JSON.stringify({ story_id: result.story_id, status: result.status, reason: result.reason }));
  }
  for (const entry of entries) {
    let result = primaryResults.get(entry.story_id)!;
    if (!result.image && stockTopic(entry.result?.story ?? {})) result = await processStockImage({ db, sourcePhoto: async () => null }, String(draft.id), entry.story_id, location);
    results.push({ story_id: result.story_id, title: entry.result?.story?.title, status: result.status, provider: result.provider, reason: result.reason,
      stages: result.stages, image: result.image, candidates: result.candidates, primary_outcome: result.primary_outcome });
  }
  const folder = path.resolve("../../.local/source-research"); await mkdir(folder, { recursive: true });
  const file = path.join(folder, `image-pipeline-preview-${locationId.replace(/[^a-z0-9-]/gi, "-")}.json`);
  await writeFile(file, JSON.stringify({ location_id: locationId, edition_id: draft.id, checked_at: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify({ preview_file: file, stories: results.length, selected: results.filter(result => result.status === "selected").length, published_data_changed: false }));
} finally { await preview?.close(); await sandbox?.stop(); await local.close(); }
