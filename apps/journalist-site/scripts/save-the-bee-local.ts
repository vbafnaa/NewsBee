import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { beeIdentity, beeIndexes, closePreviousBeeGame, consentBeeResult, editBeeGame, guessBeeLetter, previewBeeGame, shoutoutCandidates, startBeeAttempt } from "../pipeline/games/save-the-bee";
import { publishEdition } from "../pipeline/orchestration/publish";
import { LocalArtifacts } from "../pipeline/storage/artifacts";
import type { LocationProfile } from "../pipeline/connectors/types";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const site = path.join(root, "apps", "journalist-site");
const data = path.join(root, ".local", "save-the-bee");
const location = "garden-demo-wa", current = "bee-demo", previous = "bee-previous", next = "bee-next-preview";
const ballard = { id: "ballard-wa", name: "Ballard, WA" };
const compact = "bee-ballard", compactNext = "bee-ballard-next";
const readerPort = 4328, editorPort = 3008, mongoPort = 27038;
const folder = `mongo:${"b".repeat(32)}`;
const children: ChildProcess[] = [];
await mkdir(path.join(data, "mongo"), { recursive: true });
// Never use an inherited database URI, Drive account, model, or pipeline scheduler.
const mongo = await MongoMemoryReplSet.create({
  instanceOpts: [{ port: mongoPort, dbPath: path.join(data, "mongo") }],
  replSet: { count: 1, name: "bee-local", ip: "127.0.0.1", storageEngine: "wiredTiger" },
});
const client = await MongoClient.connect(mongo.getUri());
const db = client.db("newsbee_bee_fixture");
const store = new LocalArtifacts(path.join(data, "drive"));
const editor = "local-admin@localhost";
await beeIndexes(db);

async function draft(id: string, word?: string, clue?: string, place = { id: location, name: "Garden Demo, WA" }) {
  const at = Date.now() / 1000;
  await db.collection("editions").insertOne({
    id, run_id: id, location_id: place.id, location_name: place.name, status: "built",
    today: "2026-11-12", created_at: at, built_at: at, window_start: "2026-11-12", window_end: "2026-11-19",
    tokens: {}, summary: { held: 0 }, published: {
      id, location_id: place.id, location_name: place.name, window_start: "2026-11-12", window_end: "2026-11-19",
      published_at: at, headline: place.id === ballard.id ? "A little neighborhood news from Ballard" : id === next ? "Next edition: a fresh patch of possibilities" : "Good things are growing in Garden Demo",
      intro: "An isolated local edition for our neighborhood's new game. These are fixture stories, not real reporting.",
      media_mode: "none", coverage: [], corrections: [],
      items: [{ story_id: `${id}-garden`, headline: place.id === ballard.id ? "Local fixture: neighbors meet at the library" : "A small garden, a big welcome",
        blurb: place.id === ballard.id ? "This fictional sample edition includes a library meetup and a neighborhood market." : "Neighbors planted a cheerful patch of clover and flowers. Take a little pause and help our bee home in this edition's word game.",
        when_where: "Local demonstration fixture", event_date: "2026-11-12", source_url: null, kind: "local_news",
        source_name: "Demo newsroom", rank: 1, section_id: "news", local: true }],
    },
  });
  await db.collection<{ _id: string } & Record<string, unknown>>("pipeline_runs").insertOne({
    _id: id, location_id: place.id, location_name: place.name, kind: "edition", status: "built",
    edition_id: id, created_at: at, completed_at: at, today: "2026-11-12", options: { count_history: false },
    sources: [], window: ["2026-11-12", "2026-11-19"], trigger: { kind: "manual", by: editor },
  });
  const game = await previewBeeGame(db, place.id, id);
  return word ? editBeeGame(db, place.id, id, { action: "save", revision: game.revision, word, clue }, editor) : game;
}
async function shareFixtureResult(db: Db, editionId: string, word: string, name: string, place = location) {
  const owner = beeIdentity(`fixture-${editionId}`);
  const a = await startBeeAttempt(db, place, editionId, owner, false);
  for (const letter of new Set(word)) await guessBeeLetter(db, place, editionId, owner, a.id, letter);
  await consentBeeResult(db, place, editionId, owner, { public: true, nickname: name, shoutout: true });
}
if (!(await db.collection("editions").findOne({ location_id: location }))) {
  await db.collection<LocationProfile & { _id: string }>("locations").insertOne({
    _id: location, id: location, name: "Garden Demo, WA", state: "WA", systems: [], government: null,
    directory_edition: "Local game fixture", latitude: 47.6, longitude: -122.3,
  });
  await db.collection<{ _id: string } & Record<string, unknown>>("output_channels").updateOne({ _id: "reader-site" },
    { $set: { enabled: true, drive_folder_id: folder } }, { upsert: true });
  let game = await draft(previous, "HONEY", "A hive's sweet golden treasure.");
  await editBeeGame(db, location, previous, { action: "approve", revision: game.revision }, editor);
  await publishEdition(db, store, location, previous, editor, folder);
  await shareFixtureResult(db, previous, "HONEY", "Sunny Bee");
  game = await draft(current, "CLOVER", "A meadow plant with three little leaves.");
  await closePreviousBeeGame(db, location, current);
  const source = await shoutoutCandidates(db, location, current);
  await editBeeGame(db, location, current, { action: "approve", revision: game.revision, shoutoutIds: source.candidates.map(c => c.attemptId) }, editor);
  await publishEdition(db, store, location, current, editor, folder);
  await shareFixtureResult(db, current, "CLOVER", "Daisy Bee");
  await draft(next, "TULIP", "A spring flower shaped like a little cup.");
}
if (!(await db.collection("editions").findOne({ location_id: ballard.id }))) {
  await db.collection<LocationProfile & { _id: string }>("locations").insertOne({
    _id: ballard.id, ...ballard, state: "WA", systems: [], government: null, directory_edition: "Local game fixture",
  });
  const prior = "bee-ballard-previous";
  let game = await draft(prior, undefined, undefined, ballard);
  await editBeeGame(db, ballard.id, prior, { action: "approve", revision: game.revision }, editor);
  await publishEdition(db, store, ballard.id, prior, editor, folder);
  await shareFixtureResult(db, prior, game.word, "River", ballard.id);
  game = await draft(compact, undefined, undefined, ballard);
  await closePreviousBeeGame(db, ballard.id, compact);
  const source = await shoutoutCandidates(db, ballard.id, compact);
  await editBeeGame(db, ballard.id, compact, { action: "approve", revision: game.revision, shoutoutIds: source.candidates.map(c => c.attemptId) }, editor);
  await publishEdition(db, store, ballard.id, compact, editor, folder);
  await draft(compactNext, undefined, undefined, ballard);
}
const env: NodeJS.ProcessEnv = {
  ...process.env, NODE_ENV: "development", NEWSBEE_MODE: "local", NEWSBEE_ROOT: root,
  MONGODB_URI: mongo.getUri(), MONGODB_DATABASE: "newsbee_bee_fixture",
  NEWSBEE_LOCAL_DRIVE_DIR: path.join(data, "drive"), NEWSBEE_READER_SITE_URL: `http://127.0.0.1:${readerPort}/reader`,
  NEWSBEE_READER_DRIVE_FOLDER_ID: "bee-local-fixture", NEWSBEE_OUTPUT_CHANNEL_ID: "reader-site",
  AUTH_SECRET: randomBytes(32).toString("hex"), CRON_SECRET: randomBytes(32).toString("hex"),
  NEWSBEE_MODEL_PROVIDERS: "", NEWSBEE_NEWS_SEARCH: "off", NEWSBEE_LLM_DISCOVERY: "false",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "",
};
delete env.VERCEL;
function run(name: string, entry: string, args: string[], cwd: string) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: "inherit", windowsHide: true });
  children.push(child);
  child.on("error", error => { console.error(`${name}:`, error); void stop(1); });
  child.on("exit", code => { if (!stopping) { console.error(`${name} exited (${code})`); void stop(code ?? 1); } });
}
let stopping = false;
async function stop(code: number) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill();
  await client.close();
  await mongo.stop({ doCleanup: false, force: false });
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
run("journalist", path.join(site, "node_modules", "next", "dist", "bin", "next"), ["dev", "--hostname", "127.0.0.1", "--port", String(editorPort)], site);
const reader = path.join(root, "apps", "reader-site");
run("reader", path.join(reader, "node_modules", "astro", "bin", "astro.mjs"), ["dev", "--host", "127.0.0.1", "--port", String(readerPort)], reader);
const live = await db.collection("editions").find({ location_id: ballard.id, status: "published" }).sort({ published_at: -1 }).limit(1).next();
console.log(`Guide the Bee Home fixture: http://127.0.0.1:${readerPort}/reader?location=${ballard.id}&edition=${live?.id ?? compact}`);
console.log(`Editor preview: http://127.0.0.1:${editorPort}/locations/${ballard.id}?tab=published#bee-review-${compactNext}`);
console.log(`Mongo: localhost:${mongoPort} / newsbee_bee_fixture. Persistent data: ${data}. No pipeline ticks or external calls.`);
