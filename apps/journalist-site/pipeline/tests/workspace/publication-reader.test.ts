import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePublicationRelease,
  publicationContentHash,
  type PublicationManifestV1,
  type PublicationReleasePayloadV1,
} from "../../../../../shared/publication-release";
import { mongoChannelFolderId, ReaderChannelDisabledError, resolveReaderDriveFolderId } from "../../../../../shared/reader-folder";
import {
  loadReaderPublication,
  publicationArchive,
  publicationBrowseCatalog,
  publicationDirectory,
  readerData,
  readerMongoClient,
  searchTownDirectory,
} from "../../../../reader-site/src/lib/reader-data";
import { loadPublicationPage } from "../../../../reader-site/src/lib/publication-view";
import { POST as campaignSignup } from "../../../../reader-site/src/pages/api/campaign-signups";
import { GET as editionsIndex } from "../../../../reader-site/src/pages/api/editions/index";

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
const databaseName = "publication-reader";
const location = { id: "shared-wa", name: "Shared, WA" };
const publicationA = "a".repeat(32);
const publicationB = "b".repeat(32);
let seedRevision = 0;

function payload(publicationId: string, releaseId: string): PublicationReleasePayloadV1 {
  return {
    schema_version: 1,
    draft_id: `${publicationId}-draft`,
    draft_revision: 4,
    release_id: releaseId,
    publication: {
      id: publicationId,
      profile_revision: 2,
      display_name: publicationId === publicationA ? "North Weekly" : "South Weekly",
      description: "Independent local reporting.",
      homepage_url: null,
      logo_url: null,
    },
    sponsor_placements: { revision: 0, placements: [] },
    title: "Shared location weekly edition",
    intro: "The latest reporting for Shared.",
    window_start: "2026-11-09",
    window_end: "2026-11-15",
    locations: [location],
    sections: [{ id: "community", title: "Community" }],
    items: [{
      item_id: "story-1",
      story_id: "story-1",
      origin: "generated",
      source_references: [{
        location_id: location.id,
        edition_id: "source-edition",
        story_id: "source-story",
      }],
      location_ids: [location.id],
      location_names: [location.name],
      section_id: "community",
      section_title: "Community",
      headline: "Library expands weekend hours",
      blurb: "The library will open on Sunday afternoons.",
      byline: "",
      when_where: "Sundays at the main branch",
      event_date: "2026-11-15",
      source_url: "https://library.example.test/hours",
      sources: [{ name: "Library notice", url: "https://library.example.test/hours" }],
      rank: 1,
      kind: "local_news",
    }],
    correction: null,
    approval: {
      draft_revision: 4,
      draft_content_hash: "a".repeat(64),
      approved_by: { id: "editor", email: "editor@example.test" },
      approved_at: 1_762_000_000,
    },
    published_by: { id: "publisher", email: "publisher@example.test" },
    published_at: 1_762_000_100,
  };
}

async function seedPublication(publicationId: string, coveredLocations = [location], game?: PublicationReleasePayloadV1["save_the_bee"], body?: string,
  customize?: (release: PublicationReleasePayloadV1) => void) {
  const manifestRevision = ++seedRevision;
  const releaseId = `${publicationId}-release-${manifestRevision}`;
  const release = payload(publicationId, releaseId);
  if (body !== undefined) {
    release.items[0].origin = "original";
    release.items[0].blurb = body;
  }
  if (game) release.save_the_bee = game;
  release.locations = coveredLocations;
  release.items = coveredLocations.map((covered, index) => ({
    ...release.items[0],
    item_id: `story-${index + 1}`,
    story_id: `story-${index + 1}`,
    location_ids: [covered.id],
    location_names: [covered.name],
    source_references: [{
      location_id: covered.id, edition_id: "source-edition", story_id: `source-story-${index + 1}`,
    }],
  }));
  customize?.(release);
  const contentHash = publicationContentHash(release);
  const folderId = mongoChannelFolderId(publicationId);
  const artifactFileId = `${folderId}/publication-release-${releaseId}.json`;
  const manifestFileId = `${folderId}/publication-manifest-${manifestRevision}.json`;
  const manifest: PublicationManifestV1 = {
    schema_version: 1,
    publication: release.publication,
    revision: manifestRevision,
    generated_at: release.published_at,
    latest: {
      release_id: releaseId,
      title: release.title,
      window_start: release.window_start,
      window_end: release.window_end,
      published_at: release.published_at,
      content_hash: contentHash,
      artifact_file_id: artifactFileId,
      locations: release.locations,
      supersedes_release_id: null,
      withdrawn: false,
      withdrawal_reason: null,
    },
    archive: [],
  };
  manifest.archive = [manifest.latest!];
  await db.collection("output_channels").insertOne({
    _id: publicationId,
    owner_id: "owner",
    name: release.publication.display_name,
    enabled: true,
    destinations: [{ type: "reader", url: "" }],
    drive_folder_id: folderId,
    profile: {
      schema_version: 1,
      revision: 2,
      values: {
        display_name: release.publication.display_name,
        description: release.publication.description,
        homepage_url: null,
        logo_url: null,
      },
    },
    reader_publication: {
      manifest_file_id: manifestFileId,
      manifest_revision: manifestRevision,
      latest_release_id: releaseId,
      latest_published_at: release.published_at,
      latest_title: release.title,
      latest_window_start: release.window_start,
      latest_window_end: release.window_end,
      location_ids: coveredLocations.map((covered) => covered.id),
      locations: coveredLocations,
      publication: release.publication,
    },
  });
  await db.collection("output_channel_files").insertMany([
    {
      _id: artifactFileId,
      folder_id: folderId,
      name: `publication-release-${releaseId}.json`,
      value: JSON.stringify(release),
    },
    {
      _id: manifestFileId,
      folder_id: folderId,
      name: `publication-manifest-${manifestRevision}.json`,
      value: JSON.stringify(manifest),
    },
    {
      _id: `${folderId}/unrelated-history.json`,
      folder_id: folderId,
      name: "unrelated-history.json",
      value: "{malformed historical content",
    },
  ]);
  return { release, manifest, manifestFileId };
}

it("keeps old omitted-game hashes compatible and renders only a release-scoped optional game", async () => {
  const { release } = await seedPublication(publicationA);
  const oldHash = publicationContentHash(release);
  expect((await loadReaderPublication(publicationA, release.release_id, db))?.release).not.toHaveProperty("save_the_bee");
  expect(publicationContentHash((await loadReaderPublication(publicationA, release.release_id, db))!.release)).toBe(oldHash);
  expect((await loadPublicationPage(publicationA, release.release_id))?.beeGame).toBeUndefined();
  const withGame = await seedPublication(publicationB, [location], { word: "CLOVER", clue: "A plant with three little leaves." });
  const page = await loadPublicationPage(publicationB, withGame.release.release_id);
  expect(page?.beeGame?.api).toContain(`publication=${publicationB}`);
  expect(page?.beeGame?.api).toContain(`release=${withGame.release.release_id}`);
  expect(JSON.stringify(page)).not.toContain("CLOVER");
});

function submitCampaignSignup() {
  const url = new URL("http://localhost/reader/api/campaign-signups");
  return campaignSignup({
    request: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: url.origin },
      body: JSON.stringify({
        campaign: "newsroom",
        email: "publisher@example.test",
        context: "Shared Weekly",
        role: "Independent journalist",
        interest: "Organizing sources and drafts",
        utm_source: "publication-directory-test",
      }),
    }),
    url,
  } as Parameters<typeof campaignSignup>[0]);
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db(databaseName);
});

beforeEach(async () => {
  await db.dropDatabase();
  delete (globalThis as typeof globalThis & { newsbeeReaderData?: unknown }).newsbeeReaderData;
  vi.stubEnv("MONGODB_URI", server.getUri());
  vi.stubEnv("MONGODB_DATABASE", databaseName);
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubEnv("NEWSBEE_OUTPUT_CHANNEL_ID", "reader-site");
  vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "");
});

afterAll(async () => {
  const { client: readerClient } = await readerMongoClient();
  await readerClient.close();
  delete (globalThis as typeof globalThis & { newsbeeReaderMongo?: unknown }).newsbeeReaderMongo;
  vi.unstubAllEnvs();
  await client?.close();
  await server?.stop();
});

it("maps one location to multiple independent publications", async () => {
  await seedPublication(publicationA);
  await seedPublication(publicationB);
  expect(await publicationDirectory(location.id, db)).toMatchObject([
    { id: publicationA, locations: [location], latest_title: "Shared location weekly edition" },
    { id: publicationB, locations: [location], latest_title: "Shared location weekly edition" },
  ]);
});

it.each(["First paragraph.\n\nSecond paragraph.", "First line.\r\nSecond line.\tDetails."])(
  "reads immutable multiline originals without changing their hash: %j", async (body) => {
    const { release } = await seedPublication(publicationA, [location],
      { word: "CLOVER", clue: "A plant with three little leaves." }, body);
    const before = await db.collection("output_channel_files").find({}).toArray();
    const loaded = await loadReaderPublication(publicationA, release.release_id, db);
    expect(loaded?.release).toEqual(release);
    expect(publicationContentHash(loaded!.release)).toBe(publicationContentHash(release));
    const page = await loadPublicationPage(publicationA, release.release_id);
    expect(page?.articles[0].text).toBe(body);
    expect(page?.beeGame).toBeDefined();
    expect(await db.collection("output_channel_files").find({}).toArray()).toEqual(before);
  },
);

it("keeps body bounds, dangerous controls, identity, headline and schema validation strict", () => {
  const release = payload(publicationA, "strict-release");
  for (const body of ["", "x".repeat(20_001), ...["\0", "\b", "\v", "\f", "\x1b", "\x7f"].map((control) => `Text${control}more`)]) {
    expect(parsePublicationRelease({ ...release, items: [{ ...release.items[0], blurb: body }] })).toBeNull();
  }
  for (const key of ["item_id", "story_id", "headline", "section_id"]) {
    expect(parsePublicationRelease({ ...release, items: [{ ...release.items[0], [key]: "Invalid\nline" }] })).toBeNull();
  }
  expect(parsePublicationRelease({ ...release, schema_version: 2 })).toBeNull();
});

it("serves real publication routes and browse with disabled legacy content while preserving genuine failures", async () => {
  const { release } = await seedPublication(publicationA, [location],
    { word: "CLOVER", clue: "A plant with three little leaves." },
    "First reported paragraph.\n\nSecond reported paragraph with <script>escaped text</script>.", (release) => {
      release.sections = [{ id: "events", title: "Community guides" }];
      const guide = {
        ...release.items[0], section_id: "events", section_title: "Community guides",
        image: "https://library.example.test/illustration.png",
        image_credit: "Newsroom - AI-generated illustration",
        image_source_url: "https://library.example.test/image-source",
        image_date: "2026-11-09",
        image_license: "CC0",
        image_license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
      };
      release.items = [
        ...Array.from({ length: 6 }, (_, index) => ({
          ...guide, item_id: `story-${index + 1}`, story_id: `story-${index + 1}`,
          headline: index ? `Library service guide ${index + 1}` : guide.headline, rank: index + 1,
        })),
        { ...release.items[0], item_id: "future-event", story_id: "future-event", kind: "event",
          headline: "Upcoming reading event", event_date: "2026-11-20", rank: 7 },
      ];
    });
  const legacyFolder = mongoChannelFolderId("c".repeat(32));
  await db.collection("output_channels").insertOne({
    _id: "reader-site", enabled: false, drive_folder_id: legacyFolder,
  });
  const invalid = await seedPublication(publicationB);
  const folderId = mongoChannelFolderId(publicationB);
  await db.collection("output_channel_files").updateOne(
    { _id: `${folderId}/publication-release-${invalid.release.release_id}.json` },
    { $set: { value: JSON.stringify({ ...invalid.release, title: "Tampered headline" }) } },
  );
  const { default: dev } = await import("../../../../reader-site/node_modules/astro/dist/core/dev/index.js");
  const vitest = process.env.VITEST;
  delete process.env.VITEST;
  let reader: Awaited<ReturnType<typeof dev>>;
  try {
    reader = await dev({
      root: new URL("../../../../reader-site/", import.meta.url),
      logLevel: "silent", server: { host: "127.0.0.1", port: 0 },
      vite: { optimizeDeps: { noDiscovery: true, include: [] } },
    });
  } finally {
    if (vitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = vitest;
  }
  const proxy = createServer((request, response) => reader.handle(request, response));
  try {
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/reader/publications`;
    for (const suffix of ["", `/releases/${release.release_id}`]) {
      const response = await fetch(`${origin}/${publicationA}${suffix}?story=story-1`);
      const html = await response.text();
      expect(response.status, html.slice(0, 1000)).toBe(200);
      expect(html).toMatch(/<p[^>]*>First reported paragraph\.<\/p>/);
      expect(html).toContain("Second reported paragraph with &lt;script&gt;escaped text&lt;/script&gt;.");
      expect(html).toContain('href="https://library.example.test/hours"');
      const missingStory = await fetch(`${origin}/${publicationA}${suffix}?story=missing`);
      expect(missingStory.status).toBe(404);
      expect(await missingStory.text()).toContain("This story could not be found");
    }
    const home = await fetch(`${origin}/${publicationA}`);
    const homeHtml = await home.text();
    expect(home.status).toBe(200);
    expect(homeHtml).toContain("Guide the Bee Home");
    expect(homeHtml).not.toContain("CLOVER");
    expect(homeHtml).toContain("7 stories");
    expect(homeHtml).not.toContain("Nothing listed yet");
    expect(homeHtml).not.toMatch(/<section\b[^>]*class="events"/);
    expect(homeHtml).not.toContain("Publication newsletter");
    expect(homeHtml).not.toContain("email updates");
    expect(homeHtml).toContain("Image: Newsroom - AI-generated illustration");
    expect(homeHtml).toContain("Date: 2026-11-09");
    expect(homeHtml).not.toContain("Photo: Newsroom");
    expect(homeHtml).not.toContain("Taken 2026-11-09");
    const allStories = await fetch(`${origin}/${publicationA}?section=all`);
    const allStoriesHtml = await allStories.text();
    expect(allStories.status).toBe(200);
    expect(allStoriesHtml).toContain("Upcoming reading event");
    expect(allStoriesHtml).toContain("Library service guide 6");
    const availableAtStart = await db.collection("output_channel_files").find({}).sort({ _id: 1 }).toArray();
    for (const suffix of ["", `/releases/${invalid.release.release_id}`]) {
      const response = await fetch(`${origin}/${publicationB}${suffix}`);
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("failed integrity validation");
    }
    for (const path of [`${publicationA}/releases/missing`, "unknown-publication"]) {
      const response = await fetch(`${origin}/${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("Publication unavailable");
    }
    await db.collection("output_channels").deleteOne({ _id: publicationB });
    const readerOrigin = origin.replace(/\/publications$/, "");
    for (const query of ["", `?location=${location.id}`, "?q=weekend", `?location=${location.id}&edition=publication:${publicationA}:${release.release_id}`]) {
      const response = await fetch(`${readerOrigin}/browse${query}`);
      const html = await response.text();
      expect(response.status, html.slice(0, 1000)).toBe(200);
      expect(html).toContain("Library expands weekend hours");
      expect(html).toContain("North Weekly");
      expect(html).toContain(`/publications/${publicationA}/releases/${release.release_id}?story=story-1`);
      expect(html).toContain('id="history-title"');
      expect(html).not.toContain("Stories are unavailable right now");
      expect(html).not.toContain(`/locations/${location.id}#subscribe`);
    }
    const chooser = await fetch(`${readerOrigin}/locations/${location.id}`);
    expect(chooser.status).toBe(200);
    expect(await chooser.text()).toContain("North Weekly");
    const explicitLegacy = await fetch(`${readerOrigin}/api/editions/${location.id}`);
    expect(explicitLegacy.status).toBe(503);
    expect((await db.collection("output_channels").findOne({ _id: "reader-site" }))?.enabled).toBe(false);
    expect(await db.collection("output_channel_files").find({}).sort({ _id: 1 }).toArray()).toEqual(availableAtStart);
    for (const state of [
      { enabled: false, drive_folder_id: "malformed/folder" },
      { enabled: true, drive_folder_id: legacyFolder },
    ]) {
      await db.collection("output_channels").updateOne({ _id: "reader-site" }, { $set: state });
      if (state.enabled) await db.collection("output_channel_files").insertOne({
        _id: `${legacyFolder}/locations.json`, folder_id: legacyFolder, name: "locations.json", value: "{broken JSON",
      });
      const response = await fetch(`${readerOrigin}/browse`);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("Stories are unavailable right now");
      expect((await fetch(`${readerOrigin}/locations/${location.id}`)).status).toBe(503);
    }
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await reader.stop();
  }
}, 120_000);

it("discovers independent publications while the valid legacy channel is explicitly disabled", async () => {
  await seedPublication(publicationA);
  await db.collection("output_channels").insertOne({
    _id: "reader-site", enabled: false, drive_folder_id: mongoChannelFolderId("c".repeat(32)),
  });
  const response = await editionsIndex({} as Parameters<typeof editionsIndex>[0]);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    locations: [{ location_id: location.id, edition_id: null, publication_count: 1, publications: [{ id: publicationA }] }],
  });
  await expect(readerData()).rejects.toThrow("disabled");
  expect((await db.collection("output_channels").findOne({ _id: "reader-site" }))?.enabled).toBe(false);
});

it("distinguishes explicit disabled channels from absent, malformed and failed lookups", async () => {
  const env = { NEWSBEE_READER_DRIVE_FOLDER_ID: "valid-fallback" };
  await expect(resolveReaderDriveFolderId(async () => null, env)).resolves.toBe("valid-fallback");
  await expect(resolveReaderDriveFolderId(async () => ({
    _id: "reader-site", enabled: false, drive_folder_id: "valid-folder",
  }), env)).rejects.toBeInstanceOf(ReaderChannelDisabledError);
  const malformed = resolveReaderDriveFolderId(async () => ({
    _id: "reader-site", enabled: false, drive_folder_id: "invalid/folder",
  }), env);
  await expect(malformed).rejects.toThrow("malformed");
  await expect(malformed).rejects.not.toBeInstanceOf(ReaderChannelDisabledError);
  const failure = new Error("Synthetic channel database failure");
  await expect(resolveReaderDriveFolderId(async () => { throw failure; }, env)).rejects.toBe(failure);
});

it.each([
  { enabled: false, drive_folder_id: "bad/folder" },
  { enabled: "false", drive_folder_id: "valid-folder" },
  { enabled: true },
])("reports malformed legacy configuration instead of hiding it: %j", async (channel) => {
  await seedPublication(publicationA);
  await db.collection("output_channels").insertOne({ _id: "reader-site", ...channel });
  const response = await editionsIndex({} as Parameters<typeof editionsIndex>[0]);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ detail: "Editions unavailable" });
});

it.each(["MONGODB_URI", "MONGODB_DATABASE"])("reports missing %s even with independent publications", async (key) => {
  await seedPublication(publicationA);
  vi.stubEnv(key, "");
  const response = await editionsIndex({} as Parameters<typeof editionsIndex>[0]);
  expect(response.status).toBe(503);
});

it("reports an invalid fallback for an absent channel and enabled legacy storage failures", async () => {
  await seedPublication(publicationA);
  vi.stubEnv("NEWSBEE_READER_DRIVE_FOLDER_ID", "invalid/folder");
  expect((await editionsIndex({} as Parameters<typeof editionsIndex>[0])).status).toBe(503);
  const folderId = mongoChannelFolderId("c".repeat(32));
  await db.collection("output_channels").insertOne({ _id: "reader-site", enabled: true, drive_folder_id: folderId });
  await db.collection("output_channel_files").insertOne({
    _id: `${folderId}/locations.json`, folder_id: folderId, name: "locations.json", value: "{broken JSON",
  });
  expect((await editionsIndex({} as Parameters<typeof editionsIndex>[0])).status).toBe(503);
});

it("reports database failures rather than treating them as a disabled source", async () => {
  const { client: readerClient } = await readerMongoClient();
  const failure = vi.spyOn(readerClient, "db").mockImplementation(() => { throw new Error("Synthetic database failure"); });
  try {
    expect((await editionsIndex({} as Parameters<typeof editionsIndex>[0])).status).toBe(503);
  } finally {
    failure.mockRestore();
  }
});

it("keeps a previously public archived newsroom searchable, discoverable and readable without changing artifacts", async () => {
  const { release } = await seedPublication(publicationA);
  const before = await db.collection("output_channel_files").find({}).sort({ _id: 1 }).toArray();
  await db.collection("output_channels").updateOne({ _id: publicationA }, {
    $set: { enabled: false, archived_at: 1_790_000_000, archived_was_enabled: true },
  });
  expect(await publicationDirectory(location.id, db)).toMatchObject([{
    id: publicationA, archived_at: 1_790_000_000, latest_release_id: release.release_id,
  }]);
  expect(await searchTownDirectory("Shared, WA", db)).toMatchObject([location]);
  expect(await publicationBrowseCatalog(db)).toMatchObject({
    releases: [{ publication_id: publicationA, release_id: release.release_id, items: [{ item_id: "story-1" }] }],
  });
  expect((await loadReaderPublication(publicationA, null, db))?.release).toEqual(release);
  expect((await loadReaderPublication(publicationA, release.release_id, db))?.release).toEqual(release);
  expect((await publicationArchive(publicationA, db))?.manifest.archive).toHaveLength(1);
  expect(await db.collection("output_channel_files").find({}).sort({ _id: 1 }).toArray()).toEqual(before);
});

it.each([
  { enabled: false },
  { enabled: false, archived_at: 1_790_000_000, archived_was_enabled: false },
  { enabled: false, archived_at: 1_790_000_000 },
  { enabled: false, archived_at: "1790000000", archived_was_enabled: true },
  { enabled: false, archived_at: Number.NaN, archived_was_enabled: true },
  { enabled: false, archived_at: 1_790_000_000, archived_was_enabled: true, destinations: [{ type: "video", url: "" }] },
])("does not grant public history or discovery to a disabled/nonpublic channel: %j", async (state) => {
  const { release } = await seedPublication(publicationA);
  await db.collection("output_channels").updateOne({ _id: publicationA }, { $set: state });
  expect(await publicationDirectory(location.id, db)).toEqual([]);
  expect(await searchTownDirectory("Shared, WA", db)).toEqual([]);
  expect(await publicationBrowseCatalog(db)).toMatchObject({ releases: [] });
  expect(await publicationArchive(publicationA, db)).toBeNull();
  expect(await loadReaderPublication(publicationA, null, db)).toBeNull();
  expect(await loadReaderPublication(publicationA, release.release_id, db)).toBeNull();
});

it("opens the complete combined release for either covered community while keeping independent newsroom choice", async () => {
  const other = { id: "other-wa", name: "Other, WA" };
  const { release } = await seedPublication(publicationA, [location, other]);
  await seedPublication(publicationB);
  expect((await publicationDirectory(location.id, db)).map((summary) => summary.id)).toEqual([publicationA, publicationB]);
  expect((await publicationDirectory(other.id, db)).map((summary) => summary.id)).toEqual([publicationA]);
  for (const summary of await publicationDirectory(other.id, db)) {
    const page = await loadPublicationPage(summary.id, summary.latest_release_id);
    expect(page?.coveredLocations).toEqual([location, other]);
    expect(page?.articles).toHaveLength(2);
    expect(page?.articles.map((article) => article.locationLabel)).toEqual([location.name, other.name]);
  }
  expect((await loadReaderPublication(publicationA, release.release_id, db))?.release.items).toHaveLength(2);
  expect(await loadReaderPublication(publicationA, "missing-exact-release", db)).toBeNull();
});

it("shares one Reader Mongo connection across campaign signup and publication discovery", async () => {
  await seedPublication(publicationA);
  const sharedReader = await readerMongoClient();

  const created = await submitCampaignSignup();
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({ created: true });
  expect((await readerMongoClient()).client).toBe(sharedReader.client);

  expect(await publicationDirectory(location.id)).toMatchObject([{
    id: publicationA,
    display_name: "North Weekly",
    locations: [location],
  }]);
  const readerDb = sharedReader.client.db(databaseName);
  expect(await readerDb.collection("campaign_signups").findOne({
    campaign: "newsroom",
    email: "publisher@example.test",
  })).toMatchObject({
    context: "Shared Weekly",
    attribution: { utm_source: "publication-directory-test" },
  });
  expect(await readerDb.collection("output_channels").countDocuments({ _id: publicationA })).toBe(1);

  const duplicate = await submitCampaignSignup();
  expect(await duplicate.json()).toEqual({ created: false });
  expect(await readerDb.collection("campaign_signups").countDocuments()).toBe(1);
  expect(await readerDb.collection("output_channels").countDocuments({ _id: publicationA })).toBe(1);
});

it("builds a non-duplicative browse catalog with searchable current release items", async () => {
  const { release } = await seedPublication(publicationA);
  expect(await publicationBrowseCatalog(db)).toMatchObject({
    locations: [location],
    releases: [{
      key: `publication:${publicationA}:${release.release_id}`,
      publication_id: publicationA,
      release_id: release.release_id,
      latest: true,
      withdrawn: false,
      items: [{ item_id: "story-1", headline: "Library expands weekend hours" }],
    }],
  });

});

describe("Reader artifact read bounds", () => {
  it("finds historical community coverage outside the current pointer without loading unrelated current items", async () => {
    const { manifest, manifestFileId } = await seedPublication(publicationA);
    const historical = { id: "historical-wa", name: "Historical, WA" };
    const older = {
      ...manifest.archive[0],
      release_id: "historical-release",
      locations: [historical],
      withdrawn: true,
      withdrawal_reason: "Historical withdrawal.",
    };
    await db.collection("output_channel_files").updateOne({ _id: manifestFileId }, {
      $set: { value: JSON.stringify({ ...manifest, archive: [...manifest.archive, older] }) },
    });
    await db.collection("output_channel_files").updateOne({ _id: manifest.latest!.artifact_file_id }, {
      $set: { value: "UNRELATED BODY MUST NOT BE READ" },
    });
    const result = await publicationBrowseCatalog(db, { locationId: historical.id });
    expect(result.releases).toMatchObject([{
      release_id: older.release_id, locations: [historical], withdrawn: true,
      withdrawal_reason: older.withdrawal_reason, items: null,
    }]);
    expect(result.locations.map((location) => location.id).sort()).toEqual([historical.id, location.id]);
  });

  function fakePublicationDatabase(
    rows: Array<Record<string, unknown>>,
    artifacts: Map<string, { folder_id: string; value: string }>,
  ) {
    let active = 0;
    let maximum = 0;
    const channels = {
      find: vi.fn(() => ({ sort: () => ({ toArray: async () => rows.filter((row) => row.enabled) }) })),
      findOne: vi.fn(async (filter: { _id: string }) => rows.find((row) => row.enabled && row._id === filter._id) ?? null),
    };
    const files = {
      findOne: vi.fn(async (filter: { _id: string; folder_id: string }) => {
        active += 1;
        maximum = Math.max(maximum, active);
        try {
          await new Promise((ready) => setTimeout(ready, 1));
          const found = artifacts.get(filter._id);
          return found?.folder_id === filter.folder_id ? found : null;
        } finally {
          active -= 1;
        }
      }),
    };
    const database = {
      databaseName: "fake-reader-operation-counts",
      collection: (name: string) => name === "output_channels" ? channels : files,
    } as unknown as Db;
    return { database, channels, files, maximum: () => maximum };
  }

  it("reuses listed channel rows, coalesces cold immutable reads, and bounds cross-request artifact I/O", async () => {
    await seedPublication(publicationA);
    await seedPublication(publicationB);
    const rows = await db.collection("output_channels").find({}).toArray();
    const stored = await db.collection("output_channel_files").find({}).toArray();
    const artifacts = new Map(stored.map((file) => [String(file._id), { folder_id: String(file.folder_id), value: String(file.value) }]));
    const fake = fakePublicationDatabase(rows, artifacts);
    await Promise.all([
      ...Array.from({ length: 10 }, () => publicationBrowseCatalog(fake.database)),
      ...Array.from({ length: 10 }, () => loadReaderPublication(publicationA, null, fake.database)),
    ]);
    expect(fake.channels.findOne).toHaveBeenCalledTimes(10); // Explicit page requests only, never catalog rows.
    expect(fake.files.findOne).toHaveBeenCalledTimes(4);
    expect(fake.maximum()).toBeLessThanOrEqual(6);
    fake.channels.findOne.mockClear();
    fake.files.findOne.mockClear();
    await publicationBrowseCatalog(fake.database);
    expect(fake.channels.findOne).not.toHaveBeenCalled();
    expect(fake.files.findOne).not.toHaveBeenCalled();
  });

  it("evicts rejected in-flight artifacts so a visible integrity error can be retried", async () => {
    const { release } = await seedPublication(publicationA);
    const rows = await db.collection("output_channels").find({}).toArray();
    const stored = await db.collection("output_channel_files").find({}).toArray();
    const artifacts = new Map(stored.map((file) => [String(file._id), { folder_id: String(file.folder_id), value: String(file.value) }]));
    const key = `${mongoChannelFolderId(publicationA)}/publication-release-${release.release_id}.json`;
    const original = artifacts.get(key)!;
    artifacts.set(key, { ...original, value: JSON.stringify({ ...release, title: "Tampered" }) });
    const fake = fakePublicationDatabase(rows, artifacts);
    const failed = await Promise.allSettled(Array.from({ length: 8 }, () => loadReaderPublication(publicationA, null, fake.database)));
    expect(failed.every((result) => result.status === "rejected" && String(result.reason).includes("integrity validation"))).toBe(true);
    expect(fake.files.findOne).toHaveBeenCalledTimes(2);
    artifacts.set(key, original);
    expect((await loadReaderPublication(publicationA, release.release_id, fake.database))?.release.title).toBe(release.title);
    expect(fake.files.findOne).toHaveBeenCalledTimes(3);
  });

  it("does bounded body work for a selected edition at 1,000 publications with 52 releases each", async () => {
    const { release, manifest } = await seedPublication(publicationA);
    const source = await db.collection("output_channels").findOne({ _id: publicationA });
    const artifacts = new Map<string, { folder_id: string; value: string }>();
    const rows = Array.from({ length: 1000 }, (_, index) => {
      const id = index.toString(16).padStart(32, "0");
      const folderId = mongoChannelFolderId(id);
      const locations = [{ id: `place-${index}-wa`, name: `Place ${index}, WA` }];
      const current = {
        ...release, publication: { ...release.publication, id }, locations,
        items: release.items.map((item) => ({ ...item, location_ids: locations.map((location) => location.id),
          location_names: locations.map((location) => location.name) })),
      };
      const entry = {
        ...manifest.latest!,
        locations,
        content_hash: publicationContentHash(current),
        artifact_file_id: `${folderId}/current.json`,
      };
      const archive = Array.from({ length: 52 }, (_, age) => ({
        ...entry,
        release_id: age ? `older-${age}` : entry.release_id,
        published_at: entry.published_at - age,
        artifact_file_id: age ? `${folderId}/older-${age}.json` : entry.artifact_file_id,
      }));
      const manifestFileId = `${folderId}/manifest.json`;
      artifacts.set(manifestFileId, { folder_id: folderId, value: JSON.stringify({
        ...manifest, publication: current.publication, latest: entry, archive,
      }) });
      artifacts.set(entry.artifact_file_id, { folder_id: folderId, value: JSON.stringify(current) });
      return {
        ...source,
        _id: id,
        drive_folder_id: folderId,
        reader_publication: { ...source!.reader_publication, manifest_file_id: manifestFileId, publication: current.publication },
      };
    });
    const fake = fakePublicationDatabase(rows, artifacts);
    const result = await publicationBrowseCatalog(fake.database, {
      locationId: "place-0-wa",
      editionId: `publication:${rows[0]._id}:${release.release_id}`,
    });
    expect(result.releases).toHaveLength(52);
    expect(result.locations).toHaveLength(1000);
    expect(result.releases.filter((entry) => entry.items)).toHaveLength(1);
    expect(fake.channels.findOne).not.toHaveBeenCalled();
    expect(fake.files.findOne).toHaveBeenCalledTimes(1001); // Manifest metadata plus one selected body; no history bodies.
    expect(fake.maximum()).toBeLessThanOrEqual(6);
    expect(fake.maximum()).toBeGreaterThan(1);
  });

  it("rechecks directory availability immediately rather than serving a warm enabled snapshot", async () => {
    await seedPublication(publicationA);
    expect(await publicationDirectory(location.id, db)).toHaveLength(1);
    await db.collection("output_channels").updateOne({ _id: publicationA }, { $set: { enabled: false } });
    expect(await publicationDirectory(location.id, db)).toEqual([]);
    expect(await publicationBrowseCatalog(db)).toMatchObject({ releases: [] });
    expect(await loadReaderPublication(publicationA, null, db)).toBeNull();
  });

  it("projects legacy Mongo headers without parsing unrelated bodies and rereads mutable corrections", async () => {
    const folderId = mongoChannelFolderId(publicationA);
    const legacy = {
      id: "legacy", location_id: location.id, location_name: location.name, window_start: "2026-11-09",
      window_end: "2026-11-15", published_at: 100, headline: "Original", intro: "", items: [],
    };
    const other = { ...legacy, id: "other", location_id: "other-wa", location_name: "Other, WA" };
    await db.collection("output_channel_files").insertMany([
      { _id: `${folderId}/locations.json`, folder_id: folderId, name: "locations.json",
        value: JSON.stringify({ locations: [location, { id: "other-wa", name: "Other, WA" }] }) },
      { _id: `${folderId}/legacy.json`, folder_id: folderId, name: "legacy.json", value: JSON.stringify(legacy) },
      { _id: `${folderId}/other.json`, folder_id: folderId, name: "other.json",
        value: `${JSON.stringify(other).split('"items":')[0]}"items":[BROKEN UNRELATED BODY` },
    ]);
    expect((await readerData(folderId, { locationId: location.id })).editions).toMatchObject([{ id: "legacy", headline: "Original" }]);
    await db.collection("output_channel_files").updateOne({ _id: `${folderId}/legacy.json` }, {
      $set: { value: JSON.stringify({ ...legacy, headline: "Corrected" }) },
    });
    expect((await readerData(folderId, { locationId: location.id, editionId: legacy.id })).editions)
      .toMatchObject([{ id: "legacy", headline: "Corrected" }]);
    await db.collection("output_channel_files").updateOne({ _id: `${folderId}/locations.json` }, {
      $set: { value: JSON.stringify({ locations: [] }) },
    });
    expect((await readerData(folderId, { locationId: location.id, editionId: legacy.id })).editions).toEqual([]);
  });
});

it("uses the effective release profile snapshot in location directory summaries", async () => {
  await seedPublication(publicationA);
  await db.collection("output_channels").updateOne({ _id: publicationA }, {
    $set: {
      "profile.values.display_name": "Mutable current profile",
      "profile.values.description": "Changed after publication.",
    },
  });
  expect(await publicationDirectory(location.id, db)).toMatchObject([{
    id: publicationA,
    display_name: "North Weekly",
    description: "Independent local reporting.",
  }]);
});

it("loads only the manifest pointer and selected immutable release with exact links and location tags", async () => {
  const { release } = await seedPublication(publicationA);
  const loaded = await loadReaderPublication(publicationA, null, db);
  expect(loaded?.release.release_id).toBe(release.release_id);
  const page = await loadPublicationPage(publicationA);
  expect(page).toMatchObject({
    publication: { displayName: "North Weekly" },
    coveredLocations: [location],
    articles: [{ locationLabel: "Shared, WA" }],
    topStories: [{ locationLabel: "Shared, WA" }],
  });
  expect(page?.articles[0].href).toContain(`/publications/${publicationA}/releases/${release.release_id}?story=story-1`);
});

it("preserves custom editorial section ids, titles, and ordering", async () => {
  const { release, manifest, manifestFileId } = await seedPublication(publicationA);
  const folderId = mongoChannelFolderId(publicationA);
  const customized = {
    ...release,
    sections: [
      { id: "civic-desk", title: "Civic Desk" },
      { id: "neighborhood-life", title: "Neighborhood Life" },
    ],
    items: [{ ...release.items[0], section_id: "neighborhood-life", section_title: "Neighborhood Life" }],
  };
  const contentHash = publicationContentHash(customized);
  const updatedManifest = {
    ...manifest,
    latest: { ...manifest.latest!, content_hash: contentHash },
    archive: [{ ...manifest.archive[0], content_hash: contentHash }],
  };
  await db.collection("output_channel_files").updateOne(
    { _id: `${folderId}/publication-release-${release.release_id}.json` },
    { $set: { value: JSON.stringify(customized) } },
  );
  await db.collection("output_channel_files").updateOne(
    { _id: manifestFileId },
    { $set: { value: JSON.stringify(updatedManifest) } },
  );
  const page = await loadPublicationPage(publicationA);
  expect(page?.allSections).toMatchObject([{
    id: "neighborhood-life",
    label: "Neighborhood Life",
    stories: [{ title: "Library expands weekend hours" }],
  }]);
  expect(page?.allSections.some((section) => section.id === "community")).toBe(false);
});

it("invalidates the manifest cache when the compact pointer revision advances", async () => {
  const { release, manifest } = await seedPublication(publicationA);
  expect((await loadReaderPublication(publicationA))?.release.release_id).toBe(release.release_id);
  const folderId = mongoChannelFolderId(publicationA);
  const next = {
    ...payload(publicationA, `${publicationA}-release-next`),
    title: "A newer immutable release",
    published_at: release.published_at + 100,
  };
  const contentHash = publicationContentHash(next);
  const artifactFileId = `${folderId}/publication-release-${next.release_id}.json`;
  const latest = {
    ...manifest.latest!,
    release_id: next.release_id,
    title: next.title,
    published_at: next.published_at,
    content_hash: contentHash,
    artifact_file_id: artifactFileId,
  };
  const updatedManifest: PublicationManifestV1 = {
    ...manifest,
    revision: manifest.revision + 1,
    generated_at: next.published_at,
    latest,
    archive: [latest, ...manifest.archive],
  };
  await db.collection("output_channel_files").insertOne({
    _id: artifactFileId,
    folder_id: folderId,
    name: `publication-release-${next.release_id}.json`,
    value: JSON.stringify(next),
  });
  const manifestFileId = `${folderId}/publication-manifest-${updatedManifest.revision}.json`;
  await db.collection("output_channel_files").insertOne({
    _id: manifestFileId,
    folder_id: folderId,
    name: `publication-manifest-${updatedManifest.revision}.json`,
    value: JSON.stringify(updatedManifest),
  });
  await db.collection("output_channels").updateOne({ _id: publicationA }, {
    $set: {
      "reader_publication.manifest_file_id": manifestFileId,
      "reader_publication.manifest_revision": updatedManifest.revision,
      "reader_publication.latest_release_id": next.release_id,
      "reader_publication.latest_published_at": next.published_at,
      "reader_publication.latest_title": next.title,
      "reader_publication.latest_window_start": next.window_start,
      "reader_publication.latest_window_end": next.window_end,
      "reader_publication.publication": next.publication,
    },
  });
  expect((await loadReaderPublication(publicationA))?.release.release_id).toBe(next.release_id);
});

it.each([false, true])("rejects immutable content tampering for latest and exact releases (archived=%s)", async (archived) => {
  const { release } = await seedPublication(publicationA, [location], undefined, "Authored paragraph.\n\nSecond paragraph.");
  if (archived) await db.collection("output_channels").updateOne({ _id: publicationA }, {
    $set: { enabled: false, archived_at: 1_790_000_000, archived_was_enabled: true },
  });
  const folderId = mongoChannelFolderId(publicationA);
  await db.collection("output_channel_files").updateOne(
    { _id: `${folderId}/publication-release-${release.release_id}.json` },
    { $set: { value: JSON.stringify({ ...release, items: [{ ...release.items[0], blurb: `${release.items[0].blurb}\n\nTampered paragraph.` }] }) } },
  );
  await expect(loadReaderPublication(publicationA, null, db))
    .rejects.toThrow("integrity validation");
  await expect(loadReaderPublication(publicationA, release.release_id, db))
    .rejects.toThrow("integrity validation");
});

it.each([false, true])("keeps archive and exact withdrawn releases available without resurrecting latest (archived=%s)", async (archived) => {
  const { release, manifest } = await seedPublication(publicationA);
  const folderId = mongoChannelFolderId(publicationA);
  const withdrawnEntry = {
    ...manifest.archive[0],
    withdrawn: true,
    withdrawal_reason: "Withdrawn for correction.",
  };
  const withdrawnManifest: PublicationManifestV1 = {
    ...manifest,
    revision: manifest.revision + 1,
    latest: null,
    archive: [withdrawnEntry],
  };
  const manifestFileId = `${folderId}/publication-manifest-${withdrawnManifest.revision}.json`;
  await db.collection("output_channel_files").insertOne({
    _id: manifestFileId,
    folder_id: folderId,
    name: `publication-manifest-${withdrawnManifest.revision}.json`,
    value: JSON.stringify(withdrawnManifest),
  });
  await db.collection("output_channels").updateOne({ _id: publicationA }, {
    $set: {
      ...(archived ? { enabled: false, archived_at: 1_790_000_000, archived_was_enabled: true } : {}),
      reader_publication: {
        manifest_file_id: manifestFileId,
        manifest_revision: withdrawnManifest.revision,
        latest_release_id: null,
        latest_published_at: null,
        latest_title: null,
        latest_window_start: null,
        latest_window_end: null,
        location_ids: [],
        locations: [],
        publication: null,
      },
      "profile.values.display_name": "Mutable current profile",
    },
  });
  expect(await loadReaderPublication(publicationA, null, db)).toBeNull();
  expect(await publicationDirectory(location.id, db)).toEqual([]);
  expect(await publicationBrowseCatalog(db)).toMatchObject({
    releases: [{ release_id: release.release_id, withdrawn: true, latest: false, items: null }],
  });
  expect(await publicationArchive(publicationA, db)).toMatchObject({
    summary: { display_name: "North Weekly" },
    manifest: { latest: null, archive: [{ release_id: release.release_id, withdrawn: true }] },
  });
  expect(await loadReaderPublication(publicationA, release.release_id, db)).toMatchObject({
    entry: { withdrawn: true, withdrawal_reason: "Withdrawn for correction." },
    release: { release_id: release.release_id },
  });
});

it("rejects unsafe publication-time links even when the artifact hash matches", async () => {
  const { release, manifest, manifestFileId } = await seedPublication(publicationA);
  const folderId = mongoChannelFolderId(publicationA);
  const unsafe = {
    ...release,
    sponsor_placements: {
      revision: 1,
      placements: [{
        id: "unsafe-sponsor",
        slot: "home_after_top_news",
        sponsor_name: "Unsafe sponsor",
        headline: "Unsafe link",
        body: "This must not render.",
        landing_url: "javascript:alert(1)",
        image_url: null,
        enabled: true,
      }],
    },
  };
  const contentHash = publicationContentHash(unsafe);
  const updatedManifest = {
    ...manifest,
    latest: { ...manifest.latest!, content_hash: contentHash },
    archive: [{ ...manifest.archive[0], content_hash: contentHash }],
  };
  await db.collection("output_channel_files").updateOne(
    { _id: `${folderId}/publication-release-${release.release_id}.json` },
    { $set: { value: JSON.stringify(unsafe) } },
  );
  await db.collection("output_channel_files").updateOne(
    { _id: manifestFileId },
    { $set: { value: JSON.stringify(updatedManifest) } },
  );
  await expect(loadReaderPublication(publicationA, null, db))
    .rejects.toThrow("integrity validation");
});
