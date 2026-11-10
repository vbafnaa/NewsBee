import { readFile } from "node:fs/promises";
import { MongoClient } from "mongodb";
import { parseArgs } from "node:util";
import { importPhotoCatalog, parsePhotoCatalog } from "../pipeline/images/catalog";
import { getLocation } from "../pipeline/communities/locations";

const { values } = parseArgs({ options: { manifest: { type: "string" }, local: { type: "boolean" }, apply: { type: "boolean" } } });
if (!values.manifest?.endsWith(".json")) throw new Error("Use --manifest <catalog.json>; add --local --apply to import into local Newsbee.");
const bytes = await readFile(values.manifest);
if (bytes.byteLength > 256 * 1024) throw new Error("Manifest exceeds 256 KiB");
const manifest = JSON.parse(bytes.toString("utf8"));
if (typeof manifest.location_id !== "string") throw new Error("Manifest requires location_id");
const sources = parsePhotoCatalog(manifest, manifest.location_id);
if (!values.apply) {
  console.log(JSON.stringify({ valid: true, applied: false, location_id: manifest.location_id,
    sources: sources.map(({ id, kind, status }) => ({ id, kind, status })) }, null, 2));
} else {
  if (!values.local) throw new Error("Local import requires --local --apply");
  const client = new MongoClient("mongodb://127.0.0.1:27027", { serverSelectionTimeoutMS: 10000 });
  try {
    const db = (await client.connect()).db("newsbee");
    await getLocation(db, manifest.location_id, true);
    console.log(JSON.stringify(await importPhotoCatalog(db, manifest, manifest.location_id, true), null, 2));
  } finally { await client.close(); }
}
