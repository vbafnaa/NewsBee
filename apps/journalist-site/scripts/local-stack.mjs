#!/usr/bin/env node
/**
 * One-command local stack: a persistent local MongoDB (unless MONGODB_URI is set), the
 * journalist site (http://127.0.0.1:3000 by default), the reader site
 * (http://127.0.0.1:4321/reader by default) and a pipeline tick every few seconds in place of
 * Vercel Cron.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(site, "..", "..");
const data = process.env.NEWSBEE_LOCAL_DATA_DIR
  ? path.resolve(root, process.env.NEWSBEE_LOCAL_DATA_DIR)
  : path.join(root, ".local", "stage2");
const localDriveRoot = process.env.NEWSBEE_LOCAL_DRIVE_DIR
  ? path.resolve(root, process.env.NEWSBEE_LOCAL_DRIVE_DIR)
  : path.join(data, "drive");
const readerFolderId = process.env.NEWSBEE_READER_DRIVE_FOLDER_ID ?? "newsbee-local-reader";
const reader = path.join(root, "apps", "reader-site");
const TICK_SECONDS = Number(process.env.NEWSBEE_LOCAL_TICK_SECONDS ?? 5);
const JOURNALIST_PORT = Number(process.env.NEWSBEE_LOCAL_JOURNALIST_PORT ?? 3000);
const READER_PORT = Number(process.env.NEWSBEE_LOCAL_READER_PORT ?? 4321);
const journalistOrigin = `http://127.0.0.1:${JOURNALIST_PORT}`;
const readerUrl = `http://127.0.0.1:${READER_PORT}/reader`;
const children = [];
let mongo = null;

function log(message) {
  console.log(`[local-stack] ${message}`);
}

async function seedLocalAccess(uri, databaseName) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(uri).hostname)) {
    throw new Error("Local review seeds require loopback MongoDB; remote databases are not allowed.");
  }
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db(databaseName);
    const now = new Date();
    const accounts = [
      { email: "owner@newsbee.local", principalId: "local-admin", role: "owner", enabled: true },
      { email: "admin@newsbee.local", principalId: "local-team-admin", role: "admin", enabled: true },
      { email: "editor-a@newsbee.local", principalId: "local-editor-a", role: "editor", enabled: true },
      { email: "editor-b@newsbee.local", principalId: "local-editor-b", role: "editor", enabled: true },
    ];
    for (const account of accounts) {
      await db.collection("journalist_admins").updateOne(
        { email: account.email },
        {
          $set: { ...account, updatedAt: now },
          $setOnInsert: { revision: 0, createdAt: now },
        },
        { upsert: true },
      );
    }
    await new Promise((resolve, reject) => {
      const seed = spawn(process.execPath, [
        path.join(site, "node_modules", "vite-node", "vite-node.mjs"),
        "scripts/local-review-fixtures.ts",
      ], {
        cwd: site,
        stdio: "inherit",
        env: {
          ...process.env,
          NEWSBEE_MODE: "local",
          MONGODB_URI: uri,
          MONGODB_DATABASE: databaseName,
          NEWSBEE_LOCAL_DRIVE_DIR: localDriveRoot,
          NEWSBEE_READER_DRIVE_FOLDER_ID: readerFolderId,
        },
      });
      seed.on("error", reject);
      seed.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Review fixture seed exited (${code})`)));
    });
    const campaignDefinitions = [
      {
        slug: "newsroom",
        roles: ["Independent journalist", "Staff reporter", "Editor or publisher", "Video producer", "Other"],
        interests: ["Collecting tips and story submissions", "Organizing sources and drafts", "Creating articles and newsletter briefs with AI", "Creating video for my channel"],
      },
      {
        slug: "college-journalism",
        roles: ["Student reporter", "Student editor", "Student video producer", "Faculty adviser", "Other"],
        interests: ["Pitching and submitting stories", "Organizing reporting with my campus newsroom", "Writing articles and newsletter briefs with AI", "Making video explainers", "Building a reporting portfolio"],
      },
      {
        slug: "high-school-journalism",
        roles: ["Journalism teacher", "Student media adviser", "School administrator", "Other educator"],
        interests: ["Story pitching and submissions", "Organizing sources and reviewing drafts", "Adapting a story into several formats with AI", "Making a short video explainer", "A guided reporting assignment"],
      },
      {
        slug: "branded-news",
        roles: ["Myself or my personal brand", "A local business", "A community organization", "Another brand"],
        interests: ["A local email newsletter", "A local news page", "Short video updates", "A roundup in several formats"],
      },
    ];
    const sources = ["community", "search", "newsletter", "partner"];
    const campaignLeads = Array.from({ length: 72 }, (_, index) => {
      const definition = campaignDefinitions[index % campaignDefinitions.length];
      const email = `campaign-${index + 1}@example.test`;
      return {
        _id: createHash("sha256").update(`${definition.slug}:${email}`).digest("hex"),
        campaign: definition.slug,
        email,
        context: `Local review organization ${index + 1}`,
        role: definition.roles[index % definition.roles.length],
        interest: definition.interests[index % definition.interests.length],
        attribution: {
          utm_source: sources[index % sources.length],
          utm_medium: index % 2 ? "social" : "email",
          utm_campaign: `local-review-${1 + (index % 3)}`,
          utm_content: `campaign-card-${1 + (index % 4)}`,
          utm_term: index % 2 ? "local-journalism" : "community-news",
        },
        createdAt: new Date(now.getTime() - ((index % 6 === 0 ? 2 : 12 + (index % 10)) * 24 * 60 * 60 * 1000)),
      };
    });
    await db.collection("campaign_signups").bulkWrite(campaignLeads.map((lead) => ({
      replaceOne: {
        filter: { _id: lead._id },
        replacement: lead,
        upsert: true,
      },
    })));
  } finally {
    await client.close();
  }
}

async function startMongo() {
  if (process.env.MONGODB_URI) {
    log("Using MONGODB_URI from the environment");
    return process.env.MONGODB_URI;
  }

  const { MongoMemoryReplSet } = await import("mongodb-memory-server");
  const dbPath = path.join(data, "mongo");
  mkdirSync(dbPath, { recursive: true });
  const port = Number(process.env.NEWSBEE_LOCAL_MONGO_PORT ?? 27027);
  log(`Starting local MongoDB on port ${port} (data in ${dbPath}); the first run downloads MongoDB`);
  mongo = await MongoMemoryReplSet.create({
    instanceOpts: [{ port, dbPath }],
    replSet: { count: 1, name: "newsbee-local", storageEngine: "wiredTiger", ip: "127.0.0.1" },
  });
  return mongo.getUri();
}

function run(name, command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code) => {
    log(`${name} exited (${code ?? "signal"})`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  if (mongo) await mongo.stop({ doCleanup: false, force: false }).catch(() => {});
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const uri = await startMongo();
const databaseName = process.env.MONGODB_DATABASE ?? "newsbee";
await seedLocalAccess(uri, databaseName);
if (process.env.NEWSBEE_LOCAL_SEED_ONLY === "1") {
  log("Seeded local accounts, publications, campaign leads, and Reader catalog");
  await shutdown(0);
}
const cronSecret = process.env.CRON_SECRET ?? randomBytes(16).toString("hex");
const env = {
  ...process.env,
  NEWSBEE_MODE: process.env.NEWSBEE_MODE ?? "local",
  NEWSBEE_ROOT: root,
  NEWSBEE_LOCAL_DRIVE_DIR: localDriveRoot,
  NEWSBEE_READER_DRIVE_FOLDER_ID: readerFolderId,
  MONGODB_URI: uri,
  MONGODB_DATABASE: databaseName,
  NEWSBEE_OWNER_EMAIL: process.env.NEWSBEE_OWNER_EMAIL ?? "owner@newsbee.local",
  CRON_SECRET: cronSecret,
  AUTH_SECRET: process.env.AUTH_SECRET ?? randomBytes(32).toString("hex"),
  AUTH_URL: process.env.AUTH_URL ?? journalistOrigin,
  NEWSBEE_READER_SITE_URL: process.env.NEWSBEE_READER_SITE_URL ?? readerUrl,
};

run(
  "journalist-site",
  "npx",
  ["next", "dev", "--hostname", "127.0.0.1", "--port", String(JOURNALIST_PORT)],
  site,
  env,
);
run(
  "reader-site",
  "npx",
  ["astro", "dev", "--host", "127.0.0.1", "--port", String(READER_PORT)],
  reader,
  env,
);

// Like Vercel Cron, ticks overlap: a tick stays open while its jobs run, so allow a few at once.
const MAX_TICKS = 3;
let inFlight = 0;
async function tick() {
  inFlight += 1;
  try {
    const response = await fetch(`${journalistOrigin}/api/pipeline/tick`, {
      method: "POST",
      headers: { Authorization: "Bearer " + cronSecret },
    });
    if (response.ok) {
      const result = await response.json();
      if (result.executed) log(`tick ran ${result.executed} job(s)`);
    }
  } catch {
    // The journalist site is still starting.
  } finally {
    inFlight -= 1;
  }
}
setInterval(() => {
  if (!stopping && inFlight < MAX_TICKS) void tick();
}, TICK_SECONDS * 1000);
log(`Journalist site: ${journalistOrigin}  Reader site: ${readerUrl}  (Ctrl+C to stop)`);
log("Role demos: owner /api/local-role?as=owner&returnTo=/admin/access · admin /api/local-role?as=admin&returnTo=/admin/access · editor-a/editor-b /api/local-role?as=editor-a&returnTo=/newsroom");
