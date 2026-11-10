import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { importPhotoCatalog, parsePhotoCatalog, discoverCatalogPhotos } from "../pipeline/images/catalog";
import { collapse } from "../pipeline/editions/stories";
import type { CollectedEvent } from "../pipeline/connectors/types";
import { publicHttpsGet } from "../../../shared/image-http";
import { downloadStoryImage } from "../../../shared/image-validation";
import { preparePhoto, cropPreviews } from "../pipeline/images/quality";

const { values } = parseArgs({ options: { manifest: { type: "string" }, download: { type: "string", default: "0" } } });
if (!values.manifest?.endsWith(".json")) throw new Error("Use --manifest <catalog.json> [--download 0..3]");
const downloadLimit = Number(values.download);
if (!Number.isInteger(downloadLimit) || downloadLimit < 0 || downloadLimit > 3) throw new Error("Download limit must be 0..3");
const bytes = await readFile(values.manifest);
if (bytes.byteLength > 256 * 1024) throw new Error("Manifest exceeds 256 KiB");
const manifest = JSON.parse(bytes.toString("utf8"));
const now = new Date();
const sources = parsePhotoCatalog(manifest, manifest.location_id, now);
const directory = fileURLToPath(new URL("../../../.local/source-research/", import.meta.url));
await mkdir(directory, { recursive: true });
const reportFile = path.join(directory, `photo-catalog-inspection-${manifest.location_id.replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}.json`);
let server: MongoMemoryServer | undefined;
let client: MongoClient | undefined;
try {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  const db = client.db("photo-catalog-inspection");
  await importPhotoCatalog(db, manifest, manifest.location_id, true, now);
  const results = [];
  let downloads = 0;
  for (const source of sources) {
    const kind = source.scope.kind === "street" ? "building_permit" : ["person", "organization", "story"].includes(source.scope.kind) ? "local_news" : "event";
    const story = collapse([{ source_id: "catalog-inspection", facts: {
      source_event_id: source.id, title: source.scope.name, kind,
      venue: source.scope.name, event_date: source.scope.event_date ?? now.toISOString().slice(0, 10),
      source_url: source.scope.source_urls[0] ?? source.evidence_url,
      description: "Catalog inspection context; never submitted as a news story.",
    } as CollectedEvent }])[0];
    const candidates = await discoverCatalogPhotos(db, manifest.location_id, story, source.scope.city, now, publicHttpsGet);
    const inspected = [];
    for (const candidate of candidates.filter(candidate => candidate.accepted && candidate.image)) {
      if (downloads >= downloadLimit) break;
      downloads += 1;
      try {
        const delivered = await downloadStoryImage(candidate.image!.image);
        const photo = await preparePhoto(delivered.bytes);
        await cropPreviews(photo, 0.5, 0.5, false);
        const extension = delivered.contentType === "image/png" ? "png" : delivered.contentType === "image/webp" ? "webp" : "jpg";
        const file = path.join(directory, `${photo.hash}.${extension}`);
        await writeFile(file, photo.original);
        inspected.push({ source_url: candidate.image!.image_source_url, file, hash: photo.hash,
          width: photo.width, height: photo.height, decoded: true, visual_review: "not_run" });
      } catch (error) {
        inspected.push({ source_url: candidate.image!.image_source_url, decoded: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    results.push({ source_id: source.id, status: source.status, scope: source.scope,
      metadata_candidates: candidates.length, accepted_metadata: candidates.filter(candidate => candidate.accepted).length,
      candidates, inspected });
  }
  const report = { checked_at: now.toISOString(), location_id: manifest.location_id, purpose: "catalog_inspection",
    published_data_changed: false, runtime_visual_approval: false, downloads, results };
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ report: reportFile, downloads, published_data_changed: false,
    sources: results.map(result => ({ source_id: result.source_id, status: result.status, candidates: result.metadata_candidates, accepted: result.accepted_metadata })) }, null, 2));
} finally { await client?.close(); await server?.stop(); }
