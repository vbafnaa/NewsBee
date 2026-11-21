import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const usage = "node apps/reader-site/scripts/snapshot-published-editions.mjs --source https://your-domain/reader --output .local/published-snapshots --folder READER_FOLDER_ID";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const locationId = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value);
const editionId = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const timestamp = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function argumentsFor(argv) {
  if (argv.includes("--help")) { console.log(usage); return null; }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!["--source", "--output", "--folder"].includes(key) || !argv[index + 1] || argv[index + 1].startsWith("--") || options[key]) {
      throw new Error(`Invalid or repeated argument ${key}. Usage: ${usage}`);
    }
    options[key] = argv[index + 1];
  }
  if (!options["--source"] || !options["--output"] || !options["--folder"]) throw new Error(`All three arguments are required. Usage: ${usage}`);
  const source = new URL(options["--source"]);
  if (source.protocol !== "https:" || source.username || source.password || source.search || source.hash) throw new Error("Source must be a public HTTPS base URL without credentials, query, or fragment.");
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(options["--folder"])) throw new Error("Folder must be an ordinary reader-folder identifier without path separators.");
  return { source: source.href.replace(/\/+$/, ""), output: path.resolve(options["--output"]), folder: options["--folder"] };
}

async function getJson(url) {
  const response = await fetch(url, { method: "GET", redirect: "error", headers: { Accept: "application/json", "User-Agent": "Newsbee-Public-Snapshot/1.0" }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Public GET ${url} returned HTTP ${response.status}.`);
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(`Public GET ${url} did not return JSON.`);
  const maximum = 16 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximum) throw new Error(`Public JSON is too large: ${url}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maximum) throw new Error(`Public JSON is too large: ${url}`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return { value: JSON.parse(raw), wireSha256: hash(raw) }; }
  catch { throw new Error(`Public GET ${url} returned malformed JSON.`); }
}

function catalogEntries(catalog) {
  if (!record(catalog) || !Array.isArray(catalog.locations) || !catalog.locations.length) throw new Error("Public catalog must contain a nonempty locations array.");
  const seen = new Set();
  for (const entry of catalog.locations) {
    if (!record(entry) || !locationId(entry.location_id) || !nonempty(entry.location_name) || seen.has(entry.location_id)) throw new Error("Public catalog has an invalid or duplicate community identity.");
    seen.add(entry.location_id);
    if (entry.edition_id === null) {
      if (entry.published_at !== null || entry.window_start !== null || entry.window_end !== null) throw new Error(`Incomplete empty-edition metadata for ${entry.location_id}.`);
    } else if (!editionId(entry.edition_id) || !timestamp(entry.published_at) || !nonempty(entry.window_start) || !nonempty(entry.window_end)) {
      throw new Error(`Invalid published-edition metadata for ${entry.location_id}.`);
    }
  }
  return catalog.locations;
}

function validateEdition(value, entry) {
  if (!record(value) || value.id !== entry.edition_id || value.location_id !== entry.location_id || !nonempty(value.location_name) ||
      value.published_at !== entry.published_at || value.window_start !== entry.window_start || value.window_end !== entry.window_end ||
      typeof value.headline !== "string" || typeof value.intro !== "string" || !Array.isArray(value.items)) {
    throw new Error(`Pinned edition for ${entry.location_id} disagrees with the catalog or edition contract. Nothing was dropped; rerun to capture a consistent catalog.`);
  }
  for (const [index, item] of value.items.entries()) {
    if (!record(item) || typeof item.headline !== "string" || typeof item.blurb !== "string" || typeof item.when_where !== "string" ||
        typeof item.event_date !== "string" || !(typeof item.source_url === "string" || item.source_url === null) ||
        (item.sources !== undefined && (!Array.isArray(item.sources) || item.sources.some((source) => !record(source) || typeof source.name !== "string" || typeof source.url !== "string")))) {
      throw new Error(`Invalid item ${index + 1} in ${entry.edition_id}; refusing to save a partial edition.`);
    }
  }
  // Keep the complete public payload, including unknown/optional media fields and item order.
  return value;
}

async function directoryLocation(source, entry, warnings) {
  const location = { id: entry.location_id, name: entry.location_name };
  try {
    const { value } = await getJson(`${source}/api/locations/${encodeURIComponent(entry.location_id)}`);
    if (!record(value) || value.id !== entry.location_id || value.name !== entry.location_name ||
        ["branch_count", "system_count"].some((key) => value[key] !== undefined && !count(value[key]))) {
      throw new Error("Directory lookup did not match the catalog identity or optional count contract.");
    }
    for (const key of ["branch_count", "system_count"]) if (count(value[key])) location[key] = value[key];
  } catch (error) { warnings.push({ location_id: entry.location_id, detail: `Optional counts omitted: ${error.message}` }); }
  return location;
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (!options) return;
  const startedAt = new Date().toISOString();
  const catalogUrl = `${options.source}/api/editions`;
  const catalog = await getJson(catalogUrl);
  const entries = catalogEntries(catalog.value), locations = [], editions = [], warnings = [];
  const seenEditionIds = new Set();
  for (const entry of entries) {
    const pinnedUrl = entry.edition_id === null ? null : `${options.source}/api/editions/${encodeURIComponent(entry.location_id)}?${new URLSearchParams({ edition: entry.edition_id })}`;
    const [location, fetched] = await Promise.all([
      directoryLocation(options.source, entry, warnings), pinnedUrl ? getJson(pinnedUrl) : null,
    ]);
    locations.push(location);
    if (fetched) {
      if (seenEditionIds.has(entry.edition_id)) throw new Error(`Duplicate edition ID ${entry.edition_id}; refusing an ambiguous snapshot.`);
      seenEditionIds.add(entry.edition_id);
      editions.push({ entry, sourceUrl: pinnedUrl, edition: validateEdition(fetched.value, entry), wireSha256: fetched.wireSha256 });
    }
  }
  // Fetch and validate everything before creating a new snapshot. Never rewrite an old fixture.
  await mkdir(options.output, { recursive: true });
  const capturedAt = new Date().toISOString();
  const stamp = capturedAt.replace(/[:.]/g, "-");
  const driveRoot = path.join(options.output, `.${stamp}-${randomUUID().slice(0, 8)}`);
  await mkdir(driveRoot);
  const readerFolder = path.join(driveRoot, options.folder);
  await mkdir(readerFolder);
  const directory = json({ locations });
  await writeFile(path.join(readerFolder, "locations.json"), directory, { flag: "wx" });
  const records = [];
  for (const { entry, sourceUrl, edition, wireSha256 } of editions) {
    const filename = `${edition.id}.json`, contents = json(edition);
    await writeFile(path.join(readerFolder, filename), contents, { flag: "wx" });
    records.push({ location_id: entry.location_id, location_name: entry.location_name, edition_id: edition.id,
      published_at: edition.published_at, item_count: edition.items.length, file: `${options.folder}/${filename}`,
      source_url: sourceUrl, sha256: hash(contents), source_wire_sha256: wireSha256 });
  }
  const catalogContents = json(catalog.value);
  await writeFile(path.join(driveRoot, "catalog.json"), catalogContents, { flag: "wx" });
  const manifest = { schema_version: 1, source_url: options.source, started_at: startedAt, captured_at: capturedAt,
    catalog_url: catalogUrl, catalog_file: "catalog.json", catalog_sha256: hash(catalogContents), catalog_source_wire_sha256: catalog.wireSha256,
    drive_root: driveRoot, reader_folder: options.folder, directory_file: `${options.folder}/locations.json`, directory_sha256: hash(directory),
    location_count: locations.length, edition_count: editions.length,
    communities_without_editions: entries.filter((entry) => entry.edition_id === null).map((entry) => entry.location_id), editions: records, warnings };
  const manifestPath = path.join(driveRoot, "manifest.json");
  await writeFile(manifestPath, json(manifest), { flag: "wx" });
  console.log(JSON.stringify({ driveRoot, readerFolder, manifestPath, capturedAt, locations: locations.length,
    editions: records.map(({ location_id, edition_id, item_count, sha256 }) => ({ location_id, edition_id, item_count, sha256 })), warnings }, null, 2));
}

main().catch((error) => { console.error(`Snapshot failed: ${error.message}`); process.exitCode = 1; });
