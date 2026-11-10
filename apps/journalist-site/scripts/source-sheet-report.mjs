// Offline, deterministic human-readable export of the reviewed source inventory.
import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../../../", import.meta.url);
const sheet = JSON.parse(await readFile(new URL("shared/source-sheet-inventory.json", root), "utf8"));
const columns = ["row", "source", "communities", "scope", "decision", "collection_enabled_by_review", "reason", "url", "evidence", "checked_on", "review_expires", "photos"];
const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const rows = sheet.sources.map((source) => [source.number, source.name,
  source.communities.map((key) => sheet.communities[key].name).join("; "), source.scope, source.decision,
  ["approved_api", "approved_feed"].includes(source.decision), source.reason, source.url,
  source.evidence.join("; "), source.checked_at, source.review_expires, source.photos]);
await writeFile(new URL("Docs/source-sheet-access-review.csv", root), [columns, ...rows].map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n");
console.log(`Wrote ${rows.length} reviewed sources to Docs/source-sheet-access-review.csv`);
