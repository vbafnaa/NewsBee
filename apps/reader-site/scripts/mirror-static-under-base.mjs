// Vercel Services serve this app under /reader, but static lookups use the
// public request path. Mirror built assets under the base path as well.
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const base = "reader";
const staticDir = join(process.cwd(), ".vercel", "output", "static");

if (!existsSync(staticDir)) {
  throw new Error(`Static output not found at ${staticDir}`);
}

for (const entry of readdirSync(staticDir)) {
  if (entry === base) continue;
  cpSync(join(staticDir, entry), join(staticDir, base, entry), { recursive: true });
}
