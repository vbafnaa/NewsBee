#!/usr/bin/env node
/**
 * One-command local stack: a persistent local MongoDB (unless MONGODB_URI is set), the
 * journalist site (http://127.0.0.1:3000), the reader site (http://127.0.0.1:4321) and a
 * pipeline tick every few seconds in place of Vercel Cron.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(site, "..", "..");
const data = path.join(root, ".local", "stage2");
const reader = path.join(root, "projects", "reader-site");
const TICK_SECONDS = Number(process.env.NEWSBEE_LOCAL_TICK_SECONDS ?? 5);
const children = [];
let mongo = null;

function log(message) {
  console.log(`[local-stack] ${message}`);
}

async function startMongo() {
  if (process.env.MONGODB_URI) {
    log("Using MONGODB_URI from the environment");
    return process.env.MONGODB_URI;
  }
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  const dbPath = path.join(data, "mongo");
  mkdirSync(dbPath, { recursive: true });
  const port = Number(process.env.NEWSBEE_LOCAL_MONGO_PORT ?? 27027);
  log(`Starting local MongoDB on port ${port} (data in ${dbPath}); the first run downloads MongoDB`);
  mongo = await MongoMemoryServer.create({
    instance: { port, dbPath, storageEngine: "wiredTiger", ip: "127.0.0.1" },
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
const cronSecret = process.env.CRON_SECRET ?? randomBytes(16).toString("hex");
const env = {
  ...process.env,
  NEWSBEE_MODE: process.env.NEWSBEE_MODE ?? "local",
  NEWSBEE_ROOT: root,
  NEWSBEE_LOCAL_DRIVE_DIR: process.env.NEWSBEE_LOCAL_DRIVE_DIR ?? path.join(data, "drive"),
  MONGODB_URI: uri,
  MONGODB_DATABASE: process.env.MONGODB_DATABASE ?? "newsbee",
  CRON_SECRET: cronSecret,
  AUTH_SECRET: process.env.AUTH_SECRET ?? randomBytes(32).toString("hex"),
  NEWSBEE_READER_SITE_URL: process.env.NEWSBEE_READER_SITE_URL ?? "http://127.0.0.1:4321",
};

run("journalist-site", "npx", ["next", "dev", "--hostname", "127.0.0.1", "--port", "3000"], site, env);
run("reader-site", "npx", ["astro", "dev", "--host", "127.0.0.1", "--port", "4321"], reader, env);

// Like Vercel Cron, ticks overlap: a tick stays open while its jobs run, so allow a few at once.
const MAX_TICKS = 3;
let inFlight = 0;
async function tick() {
  inFlight += 1;
  try {
    const response = await fetch("http://127.0.0.1:3000/api/pipeline/tick", {
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
log("Journalist site: http://127.0.0.1:3000  Reader site: http://127.0.0.1:4321  (Ctrl+C to stop)");
