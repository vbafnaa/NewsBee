import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { GEOGRAPHIC_PLACES, OSM_ATTRIBUTION, type GeographicPlace } from "../../../shared/geography";
import type { Principal } from "../pipeline/accounts/identity";
import {
  createOutputChannel,
  type OutputChannelDocument,
} from "../pipeline/orchestration/output-channels";
import { resolvePublicationContext } from "../pipeline/publications/access";
import { patchPublicationDraft } from "../pipeline/publications/editorial";
import type { PublicationDraft } from "../pipeline/publications/generation";
import {
  approvePublicationDraft,
  changePublicationReleaseAvailability,
  createPublicationCorrection,
  loadPublicationReleaseForDistribution,
  publishPublicationDraft,
} from "../pipeline/publications/releases";
import { LocalArtifacts } from "../pipeline/storage/artifacts";
import { COLLECTIONS } from "../pipeline/storage/mongo";
import {
  newReleaseVideoJob,
  saveReleaseVideoPackage,
  type ReleaseVideoScope,
  type VideoContentPackage,
  type VideoJob,
} from "../pipeline/video-production";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const site = path.join(root, "apps", "journalist-site");
const reader = path.join(root, "apps", "reader-site");
const data = path.resolve(process.env.NEWSROOM_RELEASE_DATA_DIR ?? path.join(root, ".local", "newsroom-release"));
function localPort(name: string, compatibleName: string, fallback: number) {
  const value = Number(process.env[name] ?? process.env[compatibleName] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) throw new Error(`${name} must be a valid local port.`);
  return value;
}
const readerPort = localPort("NEWSBEE_NEWSROOM_READER_PORT", "NEWSROOM_RELEASE_READER_PORT", 4332);
const editorPort = localPort("NEWSBEE_NEWSROOM_EDITOR_PORT", "NEWSROOM_RELEASE_EDITOR_PORT", 3012);
const assignedEditorPort = localPort("NEWSBEE_NEWSROOM_ASSIGNED_EDITOR_PORT", "NEWSROOM_RELEASE_ASSIGNED_EDITOR_PORT", 3014);
const mongoPort = localPort("NEWSBEE_NEWSROOM_MONGO_PORT", "NEWSROOM_RELEASE_MONGO_PORT", 27042);
const database = "newsbee_newsroom_release_fixture";
const sharedLocation = { id: "shared-demo-wa", name: "Shared Demo, WA" };
const secondLocation = { id: "river-demo-wa", name: "River Demo, WA" };
const publicationA = "a".repeat(32);
const publicationB = "b".repeat(32);
const legacyFolder = "reader-site";
const children: ChildProcess[] = [];
const principal: Principal = {
  id: "local-admin",
  email: "local-admin@localhost",
  role: "owner",
};

const mongoPath = path.join(data, "mongo");
await mkdir(mongoPath, { recursive: true });
const mongo = await MongoMemoryReplSet.create({
  instanceOpts: [{ port: mongoPort, dbPath: mongoPath }],
  replSet: { count: 1, name: "newsroom-release-local", ip: "127.0.0.1", storageEngine: "wiredTiger" },
});
const client = await MongoClient.connect(mongo.getUri());
const db = client.db(database);
const store = new LocalArtifacts(path.join(data, "drive"));

function draft(
  id: string,
  publicationId: string,
  publicationName: string,
  locations = [sharedLocation, secondLocation],
): PublicationDraft {
  const createdAt = Date.now() / 1000;
  return {
    _id: id,
    publication_id: publicationId,
    generation_id: `${id}-generation`,
    status: "ready",
    unpublished: true,
    editable: true,
    title: publicationName,
    window: ["2026-11-09", "2026-11-15"],
    locations: locations.map((location, index) => ({ ...location, source_map_version: index + 1 })),
    stories: [{
      id: `${id}-library`,
      canonical_identity: `fixture:${id}:library`,
      location_tags: [locations[0]],
      references: [{
        run_id: `${id}-run`,
        draft_id: "legacy-shared-edition",
        entry_id: `${id}-entry`,
        story_id: "legacy-library",
        location_id: locations[0].id,
        collected_item_ids: [],
      }],
      snapshot: {
        headline: "Library expands weekend hours",
        summary: "The library added Sunday afternoon hours.",
        when_where: "Sundays at the main branch",
        event_date: "2026-11-15",
        kind: "local_news",
        section: "community",
        sources: [{ name: "Library notice", url: "https://library.example.test/hours" }],
        image: null,
      },
      review: { status: "ready", flags: [] },
    }],
    versions: {
      publication: `${publicationId}-v1`,
      preferences: `${publicationId}-preferences-v1`,
      config: "fixture-v1",
      source_maps: locations.map((location, index) => ({ location_id: location.id, version: index + 1 })),
    },
    telemetry: { actor: { id: principal.id, email: principal.email }, funding: [] },
    revision: 0,
    editorial_status: "editing",
    presentation: {
      headline: `${publicationName}: This week`,
      intro: "An isolated combined publication release for local evaluation.",
      sections: [{ id: "community", title: "Community" }],
      section_order: ["community"],
      stories: [{
        id: `${id}-library`,
        origin: "generated",
        generated_story_id: `${id}-library`,
        section_id: "community",
        headline: "Library opens on Sunday afternoons",
        body: "The main branch will open on Sunday afternoons beginning this week.",
        byline: "",
        location_tags: locations.map((location) => location.id),
        source_metadata: [{
          id: `${id}-source`,
          type: "web",
          name: "Library notice",
          url: "https://library.example.test/hours",
          note: null,
        }],
        image_id: null,
      }],
      story_order: [`${id}-library`],
    },
    updated_at: createdAt,
    updated_by: { id: principal.id, email: principal.email },
    ready_for_approval_at: null,
    ready_for_approval_by: null,
    distribution: { reader: false, email: false },
    created_at: createdAt,
  };
}

async function approveAndPublish(publicationId: string, draftValue: PublicationDraft) {
  await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).insertOne(draftValue);
  const context = (await resolvePublicationContext<OutputChannelDocument>(db, principal.id, publicationId))!;
  const ready = await patchPublicationDraft(db, context, draftValue._id, 0, {
    type: "ready_for_approval",
  }, principal);
  const approved = await approvePublicationDraft(db, context, draftValue._id, ready.revision, principal);
  return publishPublicationDraft(
    db,
    store,
    context,
    draftValue._id,
    approved.approval!.revision,
    approved.approval!.content_hash,
    principal,
  );
}

await db.dropDatabase();
await db.collection<{ _id: string } & Record<string, unknown>>(COLLECTIONS.locations).insertMany([
  { _id: sharedLocation.id, ...sharedLocation, state: "WA", systems: [], government: null },
  { _id: secondLocation.id, ...secondLocation, state: "WA", systems: [], government: null },
]);
await db.collection<GeographicPlace & { _id: string; name_lower: string }>(GEOGRAPHIC_PLACES).insertOne({
  _id: sharedLocation.id,
  id: sharedLocation.id,
  name: "Shared Demo",
  name_lower: "shared demo",
  label: sharedLocation.name,
  state: "WA",
  state_name: "Washington",
  kind: "city",
  parent_name: null,
  parent_kind: null,
  latitude: 47.6,
  longitude: -122.3,
  area: { method: "approximate_radius", radius_km: 8 },
  provider: "photon",
  osm_type: "N",
  osm_id: 1,
  website: null,
  attribution: OSM_ATTRIBUTION,
});
await db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels).insertOne({
  _id: "reader-site",
  owner_id: principal.id,
  name: "Legacy Reader",
  enabled: true,
  destinations: [{ type: "reader", url: "" }],
  drive_folder_id: legacyFolder,
  selected_location_ids: [sharedLocation.id],
  published_location_ids: [sharedLocation.id],
});
await store.saveJson(legacyFolder, "locations.json", { locations: [sharedLocation] });
await store.saveJson(legacyFolder, "legacy-shared-edition.json", {
  id: "legacy-shared-edition",
  location_id: sharedLocation.id,
  location_name: sharedLocation.name,
  window_start: "2026-11-09",
  window_end: "2026-11-15",
  published_at: Date.now() / 1000 - 100,
  headline: "Legacy neighborhood edition",
  intro: "This legacy location page remains available with its existing Reader behavior.",
  media_mode: "none",
  coverage: [],
  corrections: [],
  items: [{
    story_id: "legacy-library",
    headline: "Legacy location story",
    blurb: "This story demonstrates preserved location URLs and the existing Bee-gated page.",
    when_where: "",
    event_date: "2026-11-12",
    source_url: null,
    source_name: "Fixture newsroom",
    kind: "local_news",
    rank: 1,
  }],
});

for (const [id, name, locations] of [
  [publicationA, "North and River Weekly", [sharedLocation, secondLocation]],
  [publicationB, "Shared Independent", [sharedLocation]],
] as const) {
  await createOutputChannel(db, principal.id, id, `channel-${id}`, {
    name,
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: locations.map((location) => location.id),
  });
  await db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels).updateOne({ _id: id }, {
    $set: {
      profile: {
        schema_version: 1,
        revision: 1,
        values: {
          display_name: name,
          description: "An independent publication sharing one location with another publication.",
          homepage_url: null,
          logo_url: null,
        },
        updated_at: Date.now(),
        updated_by: principal.id,
      },
    },
  });
}
await db.collection("journalist_admins").insertOne({
  email: "local-editor@localhost",
  enabled: true,
  principalId: "local-editor",
  role: "editor",
  createdAt: new Date(),
});
await db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels).updateOne({ _id: publicationA }, {
  $set: { members: [{ principal_id: "local-editor", role: "editor" }] },
});

const first = await approveAndPublish(publicationA, draft("release-a-archive", publicationA, "North and River Weekly"));
const contextA = (await resolvePublicationContext<OutputChannelDocument>(db, principal.id, publicationA))!;
const fixtureReleaseId = first.release!.release_id;
const fixtureRelease = await loadPublicationReleaseForDistribution(db, contextA, fixtureReleaseId);
const fixtureStory = fixtureRelease.payload.items[0];
if (!fixtureStory) throw new Error("The review fixture release must include a story.");
const videoScope: ReleaseVideoScope = {
  publicationId: publicationA,
  releaseId: fixtureReleaseId,
  releaseHash: fixtureRelease.contentHash,
  item: fixtureStory,
  release: fixtureRelease.payload,
};
const packageInput = {
  youtubeTitle: "Neighborhood repair cafe opens this week",
  youtubeDescription: "A concise release-scoped package for the fixture repair cafe story.",
  youtubeTags: ["local news", "repair cafe", "north"],
  tiktokCaption: "A new neighborhood repair cafe opens this week.",
  spokenScript: "A neighborhood repair cafe opens this week with volunteer fixers and free practical help.",
  videoPrompt: "Create a vertical newsroom explainer about a neighborhood repair cafe opening this week.",
  subtitlesSrt: "1\n00:00:00,000 --> 00:00:05,000\nA neighborhood repair cafe opens this week.\n",
};
const videoPackage = await saveReleaseVideoPackage(db, videoScope, packageInput, undefined, {
  revision: 0,
  packageHash: "",
}) as VideoContentPackage;
const completedDesktop = {
  ...newReleaseVideoJob(videoScope, videoPackage),
  _id: "fixture-desktop-complete",
  provider: "desktop" as const,
  funding_identity: "managed" as const,
  credential_version: 0,
  requested_by: principal.id,
  request_id: "fixture-provider-complete",
  status: "complete" as const,
  drive_url: "https://drive.google.com/file/d/fixture-newsbee-video/view",
  created_at: Date.now() - 60_000,
  updated_at: Date.now() - 30_000,
};
const unavailableDesktop = {
  ...newReleaseVideoJob(videoScope, videoPackage),
  _id: "fixture-desktop-legacy",
  provider: "desktop" as const,
  funding_identity: "personal" as const,
  credential_owner_id: principal.id,
  credential_version: 4,
  requested_by: principal.id,
  request_id: "fixture-provider-legacy",
  status: "queued" as const,
  created_at: Date.now() - 120_000,
  updated_at: Date.now() - 120_000,
};
await db.collection<VideoJob>(COLLECTIONS.videoJobs).insertMany([completedDesktop, unavailableDesktop]);
await db.collection("journalist_funding_audit").insertMany([
  {
    run_id: completedDesktop._id,
    sponsor_id: principal.id,
    credential_version: 0,
    funding: "platform",
    funding_identity: "managed",
    provider: "desktop",
    model: "minimax-h3",
    role: "release-video-submitted",
    ok: true,
    reason: null,
    at: Date.now() / 1000,
  },
  {
    run_id: completedDesktop._id,
    sponsor_id: principal.id,
    credential_version: 0,
    funding: "platform",
    funding_identity: "managed",
    provider: "desktop",
    model: "minimax-h3",
    role: "release-video-completed",
    ok: true,
    reason: null,
    at: Date.now() / 1000,
  },
]);
const correction = await createPublicationCorrection(
  db,
  contextA,
  first.release!.release_id,
  "The fixture clarifies the library opening date.",
  principal,
);
const correctionReady = await patchPublicationDraft(db, contextA, correction._id, 0, {
  type: "ready_for_approval",
}, principal);
const correctionApproved = await approvePublicationDraft(db, contextA, correction._id, correctionReady.revision, principal);
const corrected = await publishPublicationDraft(
  db,
  store,
  contextA,
  correction._id,
  correctionApproved.approval!.revision,
  correctionApproved.approval!.content_hash,
  principal,
);
await changePublicationReleaseAvailability(
  db,
  store,
  contextA,
  corrected.release!.release_id,
  "withdraw",
  "Fixture withdrawal demonstrates latest-release fallback.",
  principal,
);
await approveAndPublish(publicationB, draft("release-b-live", publicationB, "Shared Independent", [sharedLocation]));

const unpublished = draft("release-a-approved-unpublished", publicationA, "North and River Weekly");
unpublished.created_at += 1000;
unpublished.updated_at += 1000;
await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).insertOne(unpublished);
const unpublishedReady = await patchPublicationDraft(db, contextA, unpublished._id, 0, {
  type: "ready_for_approval",
}, principal);
await approvePublicationDraft(db, contextA, unpublished._id, unpublishedReady.revision, principal);

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "development",
  NEWSBEE_MODE: "local",
  NEWSBEE_ROOT: root,
  NEWSBEE_LOCAL_DRIVE_DIR: path.join(data, "drive"),
  NEWSBEE_READER_SITE_URL: `http://127.0.0.1:${readerPort}/reader`,
  NEWSBEE_OUTPUT_CHANNEL_ID: "reader-site",
  MONGODB_URI: mongo.getUri(),
  MONGODB_DATABASE: database,
  AUTH_SECRET: randomBytes(32).toString("hex"),
  CRON_SECRET: randomBytes(32).toString("hex"),
  NEWSBEE_MODEL_PROVIDERS: "",
  NEWSBEE_NEWS_SEARCH: "off",
  NEWSBEE_LLM_DISCOVERY: "false",
  DESKTOP_VIDEO_API_KEY: "fixture-managed-desktop-video-key",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "",
};
delete env.VERCEL;

function run(name: string, entry: string, args: string[], cwd: string, override: Partial<NodeJS.ProcessEnv> = {}) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: { ...env, ...override },
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);
  child.on("error", (error) => { console.error(`${name}:`, error); void stop(1); });
  child.on("exit", (code) => { if (!stopping) { console.error(`${name} exited (${code})`); void stop(code ?? 1); } });
}

let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  await client.close();
  await mongo.stop({ doCleanup: false, force: false });
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

run("journalist", path.join(site, "node_modules", "next", "dist", "bin", "next"), ["dev", "--hostname", "127.0.0.1", "--port", String(editorPort)], site, {
  NEWSBEE_NEXT_DIST_DIR: ".next-newsroom-owner",
});
run("assigned editor", path.join(site, "node_modules", "next", "dist", "bin", "next"), ["dev", "--hostname", "127.0.0.1", "--port", String(assignedEditorPort)], site, {
  NEWSBEE_NEXT_DIST_DIR: ".next-newsroom-editor",
  NEWSBEE_LOCAL_PRINCIPAL_ROLE: "editor",
  NEWSBEE_LOCAL_PRINCIPAL_ID: "local-editor",
  NEWSBEE_LOCAL_PRINCIPAL_EMAIL: "local-editor@localhost",
});
run("reader", path.join(reader, "node_modules", "astro", "bin", "astro.mjs"), ["dev", "--host", "127.0.0.1", "--port", String(readerPort)], reader);

console.log(`Location directory: http://127.0.0.1:${readerPort}/reader/locations/${sharedLocation.id}`);
console.log(`Publication latest: http://127.0.0.1:${readerPort}/reader/publications/${publicationA}`);
console.log(`Publication archive: http://127.0.0.1:${readerPort}/reader/publications/${publicationA}/archive`);
console.log(`Publication browse: http://127.0.0.1:${readerPort}/reader/browse?location=${sharedLocation.id}`);
console.log(`Community newsletter target: http://127.0.0.1:${readerPort}/reader/subscribe?location=${sharedLocation.id}`);
console.log(`Publication newsletter target: http://127.0.0.1:${readerPort}/reader/subscribe?publication=${publicationA}`);
console.log(`Exact archived release: http://127.0.0.1:${readerPort}/reader/publications/${publicationA}/releases/${first.release!.release_id}`);
console.log(`Full story: http://127.0.0.1:${readerPort}/reader/publications/${publicationA}/releases/${first.release!.release_id}?story=release-a-archive-library`);
console.log(`Legacy location: http://127.0.0.1:${readerPort}/reader?location=${sharedLocation.id}&edition=legacy-shared-edition`);
console.log(`Newsbee Newsroom: http://127.0.0.1:${editorPort}/newsroom/${publicationA}`);
console.log(`Release video review: http://127.0.0.1:${editorPort}/newsroom/${publicationA}/releases/${fixtureReleaseId}/video/${fixtureStory.item_id}`);
console.log(`Assigned editor release video review: http://127.0.0.1:${assignedEditorPort}/newsroom/${publicationA}/releases/${fixtureReleaseId}/video/${fixtureStory.item_id}`);
console.log(`Newsbee Admin: http://127.0.0.1:${editorPort}/admin`);
console.log(`Admin Usage: http://127.0.0.1:${editorPort}/newsletter`);
console.log(`Mongo: localhost:${mongoPort} / ${database}. Persistent data: ${data}. No pipeline ticks or external calls.`);
