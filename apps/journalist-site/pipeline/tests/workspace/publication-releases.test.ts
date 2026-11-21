import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mongoChannelFolderId } from "../../../../../shared/reader-folder";
import { parsePublicationRelease, publicationContentHash } from "../../../../../shared/publication-release";
import type { Principal } from "../../accounts/identity";
import { createOutputChannel, resolveOutputChannel, updateOutputChannel, type OutputChannelDocument } from "../../orchestration/output-channels";
import { previewBeeGame } from "../../games/save-the-bee";
import { updatePublicationSettings } from "../../publications/settings";
import { resolvePublicationContext } from "../../publications/access";
import { patchPublicationDraft } from "../../publications/editorial";
import { loadPublicationPreview } from "../../publications/preview";
import type { PublicationDraft } from "../../publications/generation";
import {
  approvePublicationDraft,
  changePublicationReleaseAvailability,
  createPublicationCorrection,
  flagPublicationReleasesForSourceChange,
  listPublicationReleases,
  PublicationReleaseConflict,
  publishPublicationDraft,
  publicationDraftSnapshot,
} from "../../publications/releases";
import type { ArtifactStore } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let files: Map<string, unknown>;

const principal: Principal = {
  id: "publication-owner",
  email: "owner@example.test",
  role: "owner",
};
const publicationId = "a".repeat(32);
const draftId = "release-draft";

function draft(id = draftId): PublicationDraft {
  return {
    _id: id,
    publication_id: publicationId,
    generation_id: `${id}-generation`,
    status: "ready",
    unpublished: true,
    editable: true,
    title: "Independent Weekly",
    window: ["2026-11-09", "2026-11-15"],
    locations: [
      { id: "north-wa", name: "North, WA", source_map_version: 1 },
      { id: "south-wa", name: "South, WA", source_map_version: 2 },
    ],
    stories: [{
      id: "story-1",
      canonical_identity: "source:https://civic.example.test/park",
      location_tags: [{ id: "north-wa", name: "North, WA" }],
      references: [{
        run_id: "run-north",
        draft_id: "north-edition",
        entry_id: "entry-1",
        story_id: "source-story",
        location_id: "north-wa",
        collected_item_ids: [],
      }],
      snapshot: {
        headline: "Council adopts park plan",
        summary: "The council adopted a park plan.",
        when_where: "Nov. 10 at City Hall",
        event_date: "2026-11-10",
        kind: "local_news",
        section: "government",
        sources: [{ name: "Council agenda", url: "https://civic.example.test/park" }],
        image: null,
      },
      review: { status: "ready", flags: [] },
    }],
    versions: {
      publication: "publication-v1",
      preferences: "preferences-v1",
      config: "config-v1",
      source_maps: [
        { location_id: "north-wa", version: 1 },
        { location_id: "south-wa", version: 2 },
      ],
    },
    telemetry: { actor: { id: principal.id, email: principal.email }, funding: [] },
    revision: 0,
    editorial_status: "editing",
    presentation: {
      headline: "Independent Weekly",
      intro: "Reporting from North and South this week.",
      sections: [{ id: "government", title: "Government" }],
      section_order: ["government"],
      stories: [{
        id: "story-1",
        origin: "generated",
        generated_story_id: "story-1",
        section_id: "government",
        headline: "Council adopts park plan",
        body: "The council adopted a park plan after public testimony.",
        byline: "",
        location_tags: ["north-wa", "south-wa"],
        source_metadata: [{
          id: "source-1",
          type: "web",
          name: "Council agenda",
          url: "https://civic.example.test/park",
          note: null,
        }],
        image_id: null,
      }],
      story_order: ["story-1"],
    },
    updated_at: 1,
    updated_by: { id: principal.id, email: principal.email },
    ready_for_approval_at: null,
    ready_for_approval_by: null,
    distribution: { reader: false, email: false },
    created_at: 1,
  };
}

function memoryStore(): ArtifactStore {
  return {
    kind: "local",
    ensureFolder: async (parent, name) => `${parent}/${name}`,
    saveJson: async (parent, name, value) => {
      const id = `${parent}/${name}`;
      files.set(id, structuredClone(value));
      return id;
    },
    saveText: async (parent, name, value) => {
      const id = `${parent}/${name}`;
      files.set(id, value);
      return id;
    },
    readJson: async <T>(id: string) => structuredClone(files.get(id)) as T,
    readText: async (id) => String(files.get(id)),
    list: async (parent) => [...files.keys()].filter((id) => id.startsWith(`${parent}/`))
      .map((id) => ({ id, name: id.slice(parent.length + 1) })),
    findFolder: async () => null,
    removeFile: async (parent, name) => Number(files.delete(`${parent}/${name}`)),
  };
}

async function readyAndApprove(draftIdValue = draftId) {
  const context = (await resolvePublicationContext(db, principal.id, publicationId))!;
  const ready = await patchPublicationDraft(db, context, draftIdValue, 0, {
    type: "ready_for_approval",
  }, principal);
  const approved = await approvePublicationDraft(db, context, draftIdValue, ready.revision, principal);
  return { context, ready, approved };
}

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-releases");
});

beforeEach(async () => {
  await db.dropDatabase();
  files = new Map();
  await createOutputChannel(db, principal.id, publicationId, "publication-folder", {
    name: "Independent Weekly",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: ["north-wa", "south-wa"],
  });
  await db.collection<{ _id: string; id: string; name: string }>(COLLECTIONS.locations).insertMany([
    { _id: "north-wa", id: "north-wa", name: "North, WA" },
    { _id: "south-wa", id: "south-wa", name: "South, WA" },
  ]);
  await db.collection(COLLECTIONS.publicationDrafts).insertOne(draft());
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

describe("immutable publication releases", () => {
  it("roundtrips authored paragraphs through save, approval and immutable publication", async () => {
    const context = (await resolvePublicationContext(db, principal.id, publicationId))!;
    const body = "Original reporting, first paragraph.\n\nSecond paragraph with source attribution.";
    const originalId = "11111111-1111-4111-8111-111111111111";
    const saved = await patchPublicationDraft(db, context, draftId, 0, {
      type: "add_original_story", storyId: originalId, story: {
        headline: "Local original reporting", body, byline: "Fixture Reporter",
        sectionId: "government", locationTags: ["north-wa"],
        sourceMetadata: [{ type: "web", name: "Council agenda", url: "https://civic.example.test/park", note: null }],
      },
    }, principal);
    await expect(patchPublicationDraft(db, context, draftId, saved.revision, {
      type: "story", storyId: originalId, body: "Unsafe\u0000body",
    }, principal)).rejects.toThrow("Story body is invalid");
    const ready = await patchPublicationDraft(db, context, draftId, saved.revision, { type: "ready_for_approval" }, principal);
    const approved = await approvePublicationDraft(db, context, draftId, ready.revision, principal);
    const published = await publishPublicationDraft(db, memoryStore(), context, draftId,
      approved.revision, approved.approval!.content_hash, principal);
    const release = published.release!;
    const artifact = parsePublicationRelease(files.get(release.artifact_file_id));
    expect(artifact?.items.find((item) => item.item_id === originalId)?.blurb).toBe(body);
    expect(publicationContentHash(artifact)).toBe(release.content_hash);
    expect(release.payload.items.find((item) => item.item_id === originalId)?.blurb).toBe(body);
  });

  it("rejects a future publisher payload incompatible with Reader before claiming or writing artifacts", async () => {
    await db.collection(COLLECTIONS.publicationDrafts).updateOne({ _id: draftId }, {
      $set: { "presentation.stories.0.headline": "Invalid\nheadline" },
    });
    const { context, approved } = await readyAndApprove();
    await expect(publishPublicationDraft(db, memoryStore(), context, draftId,
      approved.revision, approved.approval!.content_hash, principal)).rejects.toThrow("Reader release contract");
    expect(files.size).toBe(0);
    expect((await db.collection(COLLECTIONS.publicationDrafts).findOne({ _id: draftId }))?.editorial_status).toBe("approved");
  });

  it("stores settings without publishing, freezes saved branding on explicit publish, and does not invent a release game", async () => {
    const access = (await resolveOutputChannel(db, principal.id, publicationId))!;
    const profile = {
      display_name: "Public Reader name", description: "Saved branding.",
      homepage_url: "https://homepage.example.test/", logo_url: null,
    };
    await updatePublicationSettings(db, access.context, principal, {
      profile: { expected_revision: 0, values: profile },
    });
    await updateOutputChannel(db, access, {
      name: "Internal workspace name", enabled: true, selectedLocationIds: ["north-wa", "south-wa"],
      destinations: [
        { type: "reader", url: "https://reference.example.test/reader" },
        { type: "video", url: "https://reference.example.test/video" },
      ],
    }, 0);
    expect(files.size).toBe(0);
    expect((await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId }))?.reader_publication).toBeUndefined();
    expect((await db.collection(COLLECTIONS.publicationDrafts).findOne({ _id: draftId }))?.editorial_status).toBe("editing");

    const { context, approved } = await readyAndApprove();
    const published = await publishPublicationDraft(db, memoryStore(), context, draftId,
      approved.approval!.revision, approved.approval!.content_hash, principal);
    expect(published.release?.payload.publication).toMatchObject({ ...profile, profile_revision: 1 });
    expect(JSON.stringify(published.release?.payload)).not.toContain("reference.example.test");
    expect([...files.keys()].every((key) => key.startsWith("publication-folder/"))).toBe(true);
    const frozenFiles = structuredClone(files);
    await updatePublicationSettings(db, context, principal, {
      profile: { expected_revision: 1, values: { ...profile, display_name: "Next release only" } },
    });
    expect(files).toEqual(frozenFiles);
    expect((await db.collection(COLLECTIONS.publicationDrafts).findOne({ _id: draftId }))?.release.payload.publication.display_name)
      .toBe("Public Reader name");
    await expect(previewBeeGame(db, "north-wa", published.release!.release_id)).rejects.toMatchObject({ status: 404 });
    expect(await db.collection("bee_games").countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.videoJobs).countDocuments()).toBe(0);
  });

  it("allows assigned journalists to self-approve, explicitly publish, correct and withdraw without operator access", async () => {
    const journalist: Principal = { id: "assigned-journalist", email: "journalist@example.test", role: "editor" };
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
      $set: { members: [{ principal_id: journalist.id, role: "editor" }] },
    });
    const context = (await resolvePublicationContext<OutputChannelDocument>(db, journalist.id, publicationId))!;
    const saved = await patchPublicationDraft(db, context, draftId, 0, {
      type: "bee_game", game: { word: " clover ", clue: " A plant with three little leaves. " },
    }, journalist);
    expect(saved).toMatchObject({ revision: 1, presentation: { save_the_bee: { word: "CLOVER", clue: "A plant with three little leaves." } } });
    expect((await loadPublicationPreview(db, journalist, publicationId, draftId, saved.revision)).snapshot.save_the_bee)
      .toEqual(saved.presentation.save_the_bee);
    await expect(loadPublicationPreview(db, journalist, publicationId, draftId, saved.revision - 1)).rejects.toThrow("changed");
    const ready = await patchPublicationDraft(db, context, draftId, saved.revision, { type: "ready_for_approval" }, journalist);
    const approved = await approvePublicationDraft(db, context, draftId, ready.revision, journalist);
    expect(approved.approval?.approved_by.id).toBe(journalist.id);
    expect(approved.updated_by.id).toBe(journalist.id);
    expect(approved.editorial_status).toBe("approved");
    expect(approved.approval?.snapshot.save_the_bee).toEqual(saved.presentation.save_the_bee);
    expect(publicationContentHash({ ...approved.approval!.snapshot, save_the_bee: { word: "TULIP", clue: "A cup-shaped spring flower." } }))
      .not.toBe(approved.approval!.content_hash);
    expect(files.size).toBe(0);
    const published = await publishPublicationDraft(
      db, memoryStore(), context, draftId, approved.revision, approved.approval!.content_hash, journalist,
    );
    const releaseId = published.release!.release_id;
    expect(published.editorial_status).toBe("published");
    const artifact = [...files.values()].map(parsePublicationRelease).find((value) => value?.release_id === releaseId)!;
    expect(artifact.save_the_bee).toEqual(saved.presentation.save_the_bee);
    const correction = await createPublicationCorrection(db, context, releaseId, "Correct a reported detail", journalist);
    expect(correction).toMatchObject({ editorial_status: "editing", correction: { created_by: { id: journalist.id } } });
    await patchPublicationDraft(db, context, correction._id, correction.revision, { type: "bee_game", game: null }, journalist);
    expect(artifact.save_the_bee?.word).toBe("CLOVER");
    expect([...files.values()].map(parsePublicationRelease).find((value) => value?.release_id === releaseId)?.save_the_bee)
      .toEqual(saved.presentation.save_the_bee);
    await changePublicationReleaseAvailability(db, memoryStore(), context, releaseId, "withdraw", "Review the reported error", journalist);
    expect(await db.collection(COLLECTIONS.publicationReleaseActions).countDocuments({
      publication_id: publicationId, release_id: releaseId, action: "withdraw", "by.id": journalist.id,
    })).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({ action: "privileged_write_access" })).toBe(0);
  });

  it("validates optional game saves, preserves revision on rejection, and omits removed games from snapshots", async () => {
    const context = (await resolvePublicationContext(db, principal.id, publicationId))!;
    const initial = draft();
    expect(await publicationDraftSnapshot(db, context, initial)).not.toHaveProperty("save_the_bee");
    for (const game of [
      { word: "AB", clue: "A sufficiently long hint." },
      { word: "CLOVER", clue: "Clover has three leaves." },
      { word: "TWO WORDS", clue: "A sufficiently long hint." },
      { word: "TULIP", clue: "Short" },
    ]) await expect(patchPublicationDraft(db, context, draftId, 0, { type: "bee_game", game }, principal)).rejects.toThrow();
    const saved = await patchPublicationDraft(db, context, draftId, 0, {
      type: "bee_game", game: { word: "TULIP", clue: "A cup-shaped spring flower." },
    }, principal);
    await expect(patchPublicationDraft(db, context, draftId, 0, { type: "bee_game", game: null }, principal)).rejects.toThrow("changed");
    const ready = await patchPublicationDraft(db, context, draftId, saved.revision, { type: "ready_for_approval" }, principal);
    const approved = await approvePublicationDraft(db, context, draftId, ready.revision, principal);
    await expect(patchPublicationDraft(db, context, draftId, approved.revision, { type: "bee_game", game: null }, principal)).rejects.toThrow();
    const reopened = await patchPublicationDraft(db, context, draftId, approved.revision, { type: "reopen_for_editing" }, principal);
    const removed = await patchPublicationDraft(db, context, draftId, reopened.revision, { type: "bee_game", game: null }, principal);
    expect(removed.revision).toBe(reopened.revision + 1);
    expect(removed.approval).toBeUndefined();
    expect(await publicationDraftSnapshot(db, context, removed)).not.toHaveProperty("save_the_bee");
    await db.collection(COLLECTIONS.publicationDrafts).updateOne({ _id: draftId }, {
      $set: { "presentation.save_the_bee": { word: "X", clue: "Invalid stored game." } },
    });
    await expect(patchPublicationDraft(db, context, draftId, removed.revision, { type: "ready_for_approval" }, principal))
      .rejects.toThrow("3-12");
  });

  it("approves an exact revision and invalidates approval before material editing", async () => {
    const { context, approved } = await readyAndApprove();
    expect(approved).toMatchObject({
      editorial_status: "approved",
      approval: { revision: 1, approved_by: { id: principal.id } },
    });
    expect(approved.approval?.content_hash).toHaveLength(64);
    await expect(approvePublicationDraft(db, context, draftId, 0, principal))
      .rejects.toBeInstanceOf(PublicationReleaseConflict);
    const reopened = await patchPublicationDraft(db, context, draftId, approved.revision, {
      type: "reopen_for_editing",
    }, principal);
    expect(reopened).toMatchObject({ editorial_status: "editing", revision: 2 });
    expect(reopened.approval).toBeUndefined();
  });

  it("publishes one immutable combined artifact and a compact manifest idempotently", async () => {
    const store = memoryStore();
    const { context, approved } = await readyAndApprove();
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
      $set: {
        profile: {
          schema_version: 1,
          revision: 3,
          values: {
            display_name: "The Independent Weekly",
            description: "Independent reporting for two communities.",
            homepage_url: "https://weekly.example.test/",
            logo_url: null,
          },
          updated_at: Date.now(),
          updated_by: principal.id,
        },
        sponsor_placements: {
          schema_version: 1,
          revision: 2,
          values: [{
            id: "local-sponsor",
            slot: "home_after_top_news",
            sponsor_name: "Local Sponsor",
            headline: "Supporting local reporting",
            body: "A publication-time placement.",
            landing_url: "https://sponsor.example.test/",
            image_url: null,
            enabled: true,
          }],
          updated_at: Date.now(),
          updated_by: principal.id,
        },
      },
    });
    context.publication = (await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId })) as typeof context.publication;
    const first = await publishPublicationDraft(
      db,
      store,
      context,
      draftId,
      approved.approval!.revision,
      approved.approval!.content_hash,
      principal,
    );
    const second = await publishPublicationDraft(
      db,
      store,
      context,
      draftId,
      approved.approval!.revision,
      approved.approval!.content_hash,
      principal,
    );
    expect(second.release?.release_id).toBe(first.release?.release_id);
    expect([...files.keys()].filter((name) => name.includes("publication-release-"))).toHaveLength(1);
    const pointer = await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
    expect(pointer?.reader_publication).toMatchObject({
      manifest_revision: 1,
      publication: { display_name: "The Independent Weekly", profile_revision: 3 },
    });
    expect(pointer?.reader_publication?.manifest_file_id).toMatch(
      /^publication-folder\/publication-manifest-1-[a-f0-9]{20}\.json$/,
    );
    expect(files.get(pointer!.reader_publication.manifest_file_id)).toMatchObject({
      revision: 1,
      latest: { release_id: first.release?.release_id },
      archive: [{ release_id: first.release?.release_id }],
    });
    expect(first.release?.payload).toMatchObject({
      publication: { display_name: "The Independent Weekly", profile_revision: 3 },
      sponsor_placements: { revision: 2, placements: [{ id: "local-sponsor" }] },
      items: [{
        location_ids: ["north-wa", "south-wa"],
        source_references: [{
          location_id: "north-wa",
          edition_id: "north-edition",
          story_id: "source-story",
        }],
      }],
    });
    expect(first.presentation).toEqual(approved.presentation);
  });

  it("retries a preserved publication claim after an artifact write fails", async () => {
    const { context, approved } = await readyAndApprove();
    const reliable = memoryStore();
    let attempts = 0;
    const flaky: ArtifactStore = {
      ...reliable,
      saveJson: async (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error("Temporary artifact failure");
        return reliable.saveJson(...args);
      },
    };
    await expect(publishPublicationDraft(
      db,
      flaky,
      context,
      draftId,
      approved.approval!.revision,
      approved.approval!.content_hash,
      principal,
    )).rejects.toThrow("Temporary artifact failure");
    const claimed = await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts)
      .findOne({ _id: draftId });
    expect(claimed).toMatchObject({
      editorial_status: "publishing",
      publish_claim: { content_hash: expect.any(String) },
    });
    const published = await publishPublicationDraft(
      db,
      reliable,
      context,
      draftId,
      approved.approval!.revision,
      approved.approval!.content_hash,
      principal,
    );
    expect(published).toMatchObject({
      editorial_status: "published",
      release: { release_id: claimed!.publish_claim!.release_id },
    });
    expect(published.publish_claim).toBeUndefined();
  });

  it("serializes concurrent publishes and rebuilds one complete manifest from committed releases", async () => {
    const secondDraftId = "release-draft-second";
    await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).insertOne(draft(secondDraftId));
    const firstApproval = await readyAndApprove();
    const secondApproval = await readyAndApprove(secondDraftId);
    const store = memoryStore();
    const [first, second] = await Promise.all([
      publishPublicationDraft(
        db, store, firstApproval.context, draftId,
        firstApproval.approved.approval!.revision,
        firstApproval.approved.approval!.content_hash,
        principal,
      ),
      publishPublicationDraft(
        db, store, secondApproval.context, secondDraftId,
        secondApproval.approved.approval!.revision,
        secondApproval.approved.approval!.content_hash,
        principal,
      ),
    ]);
    const pointer = await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
    const manifest = files.get(pointer!.reader_publication.manifest_file_id) as {
      revision: number;
      archive: Array<{ release_id: string }>;
    };
    expect(manifest.revision).toBeGreaterThanOrEqual(1);
    expect(manifest.archive.map((entry) => entry.release_id).sort()).toEqual(
      [first.release!.release_id, second.release!.release_id].sort(),
    );
    expect([...files.keys()].filter((name) => name.includes("publication-manifest-")))
      .toHaveLength(pointer!.reader_publication.manifest_revision);
  });

  it("serializes concurrent availability actions without omitting either committed action", async () => {
    const secondDraftId = "release-draft-action-second";
    await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).insertOne(draft(secondDraftId));
    const firstApproval = await readyAndApprove();
    const secondApproval = await readyAndApprove(secondDraftId);
    const store = memoryStore();
    const first = await publishPublicationDraft(
      db, store, firstApproval.context, draftId,
      firstApproval.approved.approval!.revision,
      firstApproval.approved.approval!.content_hash,
      principal,
    );
    const second = await publishPublicationDraft(
      db, store, secondApproval.context, secondDraftId,
      secondApproval.approved.approval!.revision,
      secondApproval.approved.approval!.content_hash,
      principal,
    );
    await Promise.all([
      changePublicationReleaseAvailability(
        db, store, firstApproval.context, first.release!.release_id,
        "withdraw", "First concurrent withdrawal.", principal,
      ),
      changePublicationReleaseAvailability(
        db, store, secondApproval.context, second.release!.release_id,
        "withdraw", "Second concurrent withdrawal.", principal,
      ),
    ]);
    const pointer = await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
    const manifest = files.get(pointer!.reader_publication.manifest_file_id) as {
      latest: unknown;
      archive: Array<{ release_id: string; withdrawn: boolean }>;
    };
    expect(manifest.latest).toBeNull();
    expect(manifest.archive.map((entry) => [entry.release_id, entry.withdrawn]).sort()).toEqual([
      [first.release!.release_id, true],
      [second.release!.release_id, true],
    ].sort());
  });

  it("keeps the previous immutable manifest readable when finalization fails and retries from committed state", async () => {
    const reliable = memoryStore();
    const { context, approved } = await readyAndApprove();
    const published = await publishPublicationDraft(
      db, reliable, context, draftId,
      approved.approval!.revision, approved.approval!.content_hash, principal,
    );
    const before = await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
    const previousManifest = structuredClone(files.get(before!.reader_publication.manifest_file_id));
    const failing: ArtifactStore = {
      ...reliable,
      saveJson: async (parent, name, value) => {
        if (name.startsWith("publication-manifest-")) throw new Error("Manifest storage unavailable");
        return reliable.saveJson(parent, name, value);
      },
    };
    await expect(changePublicationReleaseAvailability(
      db, failing, context, published.release!.release_id,
      "withdraw", "Temporarily withdrawn.", principal,
    )).rejects.toThrow("Manifest storage unavailable");
    const unchanged = await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
    expect(unchanged?.reader_publication).toEqual(before?.reader_publication);
    expect(files.get(before!.reader_publication.manifest_file_id)).toEqual(previousManifest);
    const retried = await changePublicationReleaseAvailability(
      db, reliable, context, published.release!.release_id,
      "withdraw", "Temporarily withdrawn.", principal,
    );
    expect(retried.latest).toBeNull();
    const after = await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
    expect(after?.reader_publication.manifest_revision).toBe(before!.reader_publication.manifest_revision + 1);
    expect(after?.reader_publication.manifest_file_id).not.toBe(before?.reader_publication.manifest_file_id);
  });

  it("refuses to claim an approved snapshot after a covered location enters removal", async () => {
    const { context, approved } = await readyAndApprove();
    await db.collection(COLLECTIONS.locations).updateOne(
      { _id: "north-wa" },
      { $set: { removal: { started_at: Date.now() / 1000 } } },
    );
    await expect(publishPublicationDraft(
      db, memoryStore(), context, draftId,
      approved.approval!.revision, approved.approval!.content_hash, principal,
    )).rejects.toThrow("approved locations were removed");
    expect(await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts)
      .findOne({ _id: draftId })).toMatchObject({ editorial_status: "approved" });
  });

  it("publishes correction successors and advances or falls back without mutating releases", async () => {
    const store = memoryStore();
    const firstApproval = await readyAndApprove();
    const first = await publishPublicationDraft(
      db,
      store,
      firstApproval.context,
      draftId,
      firstApproval.approved.approval!.revision,
      firstApproval.approved.approval!.content_hash,
      principal,
    );
    const correction = await createPublicationCorrection(
      db,
      firstApproval.context,
      first.release!.release_id,
      "The implementation date was clarified after publication.",
      principal,
    );
    const correctedReady = await patchPublicationDraft(db, firstApproval.context, correction._id, 0, {
      type: "ready_for_approval",
    }, principal);
    const correctedApproval = await approvePublicationDraft(
      db,
      firstApproval.context,
      correction._id,
      correctedReady.revision,
      principal,
    );
    firstApproval.context.publication.profile = {
      schema_version: 1,
      revision: 3,
      values: {
        display_name: "Corrected Release Weekly",
        description: "Profile captured for the correction.",
        homepage_url: null,
        logo_url: null,
      },
    };
    const corrected = await publishPublicationDraft(
      db,
      store,
      firstApproval.context,
      correction._id,
      correctedApproval.approval!.revision,
      correctedApproval.approval!.content_hash,
      principal,
    );
    expect(corrected.release?.payload.correction?.supersedes_release_id).toBe(first.release?.release_id);
    const withdrawn = await changePublicationReleaseAvailability(
      db,
      store,
      firstApproval.context,
      corrected.release!.release_id,
      "withdraw",
      "The corrected release needs another source review.",
      principal,
    );
    expect(withdrawn.latest?.release_id).toBe(first.release?.release_id);
    expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId }))
      .toMatchObject({ reader_publication: { publication: first.release!.payload.publication } });
    const restored = await changePublicationReleaseAvailability(
      db,
      store,
      firstApproval.context,
      corrected.release!.release_id,
      "restore",
      "The source review was completed.",
      principal,
    );
    expect(restored.latest?.release_id).toBe(corrected.release?.release_id);
    expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId }))
      .toMatchObject({ reader_publication: { publication: corrected.release!.payload.publication } });
    expect(restored.archive).toHaveLength(2);
    expect(await db.collection(COLLECTIONS.publicationReleaseActions).countDocuments()).toBe(2);
  });

  it("rolls back correction and availability mutations when their audit insert fails", async () => {
    const store = memoryStore();
    const { context, approved } = await readyAndApprove();
    const published = await publishPublicationDraft(
      db, store, context, draftId,
      approved.approval!.revision, approved.approval!.content_hash, principal,
    );
    await db.command({
      collMod: COLLECTIONS.publicationAccessAudit,
      validator: { action: { $ne: "release_correction_created" } },
      validationLevel: "strict",
      validationAction: "error",
    });
    await expect(createPublicationCorrection(
      db, context, published.release!.release_id, "Audit must be atomic.", principal,
    )).rejects.toThrow();
    expect(await db.collection(COLLECTIONS.publicationDrafts).countDocuments({
      "correction.supersedes_release_id": published.release!.release_id,
    })).toBe(0);
    await db.command({
      collMod: COLLECTIONS.publicationAccessAudit,
      validator: { action: { $ne: "release_withdrawn" } },
      validationLevel: "strict",
      validationAction: "error",
    });
    const pointer = await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId });
    await expect(changePublicationReleaseAvailability(
      db, store, context, published.release!.release_id,
      "withdraw", "Audit must be atomic.", principal,
    )).rejects.toThrow();
    expect(await db.collection(COLLECTIONS.publicationReleaseActions).countDocuments({
      release_id: published.release!.release_id,
    })).toBe(0);
    expect((await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId }))
      ?.reader_publication).toEqual(pointer?.reader_publication);
  });

  it("records repeated source withdrawal and restore cycles without changing release content", async () => {
    const store = memoryStore();
    const { context, approved } = await readyAndApprove();
    const published = await publishPublicationDraft(
      db,
      store,
      context,
      draftId,
      approved.approval!.revision,
      approved.approval!.content_hash,
      principal,
    );
    for (const [action, reason] of [
      ["source_withdrawal", "Source removed."],
      ["source_restore", "Source restored."],
      ["source_withdrawal", "Source removed again."],
      ["source_withdrawal", "Duplicate request."],
    ] as const) {
      await flagPublicationReleasesForSourceChange(
        db, "north-wa", "source-story", action, reason, principal,
      );
    }
    const rows = await db.collection(COLLECTIONS.publicationReleaseActions)
      .find({ release_id: published.release!.release_id }).sort({ at: 1, _id: 1 }).toArray();
    expect(rows.map((row) => row.action)).toEqual([
      "source_withdrawal",
      "source_restore",
      "source_withdrawal",
    ]);
    expect((await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts)
      .findOne({ _id: draftId }))?.release?.content_hash).toBe(published.release!.content_hash);
    expect(await listPublicationReleases(db, context)).toMatchObject([{
      releaseId: published.release!.release_id,
      correctionRequired: true,
      sourceChanges: [{
        action: "source_withdrawal",
        reason: "Source removed again.",
        source: { location_id: "north-wa", story_id: "source-story" },
      }],
    }]);
  });

  it("excludes held stories and incomplete excluded sections consistently from approval and output", async () => {
    const value = draft();
    value.inclusion_version = 1;
    value.stories.push({ ...structuredClone(value.stories[0]), id: "held",
      review: { status: "held", flags: ["summary:too_many_words"] } });
    value.presentation.sections.push({ id: "excluded-section", title: "" });
    value.presentation.section_order.push("excluded-section");
    value.presentation.stories.push({ ...structuredClone(value.presentation.stories[0]), id: "held",
      generated_story_id: "held", section_id: "excluded-section", headline: "", body: "",
      location_tags: [], image_id: "missing-excluded-image" });
    value.presentation.story_order.push("held");
    await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).replaceOne({ _id: draftId }, value);
    const { context, approved } = await readyAndApprove();
    expect(approved.approval?.snapshot.items.map((item) => item.story_id)).toEqual(["story-1"]);
    expect(approved.approval?.snapshot.sections).toEqual([{ id: "government", title: "Government" }]);
    expect(approved.stories).toEqual(value.stories);
    expect(approved.presentation.stories[1].image_id).toBe("missing-excluded-image");
    const published = await publishPublicationDraft(db, memoryStore(), context, draftId,
      approved.approval!.revision, approved.approval!.content_hash, principal);
    expect(published.release?.payload.items.map((item) => item.story_id)).toEqual(["story-1"]);
  });

  it("resolves only typed quality holds with an actor, reason and atomic audit", async () => {
    const value = draft();
    value.inclusion_version = 1;
    value.stories[0].review = { status: "held", flags: ["summary:too_many_words"] };
    value.presentation.stories[0].included = false;
    await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).replaceOne({ _id: draftId }, value);
    const context = (await resolvePublicationContext(db, principal.id, publicationId))!;
    const included = await patchPublicationDraft(db, context, draftId, 0, {
      type: "inclusion", storyId: "story-1", included: true, reason: "Reviewed the complete edited copy and accepted its length.",
    }, principal);
    expect(included.presentation.stories[0]).toMatchObject({
      included: true, hold_resolution: { by: { id: principal.id, email: principal.email },
        flags: ["summary:too_many_words"], reason: "Reviewed the complete edited copy and accepted its length." },
    });
    expect(included.stories).toEqual(value.stories);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({ action: "story_inclusion_changed" })).toBe(1);
    expect((await publicationDraftSnapshot(db, context, included)).items).toHaveLength(1);
    const changedHold = structuredClone(included);
    changedHold.stories[0].review.flags = ["headline:headline_length"];
    await expect(publicationDraftSnapshot(db, context, changedHold)).rejects.toThrow("Resolve the reviewable hold");
    await db.command({ collMod: COLLECTIONS.publicationAccessAudit,
      validator: { action: { $ne: "story_inclusion_changed" } }, validationLevel: "strict", validationAction: "error" });
    await expect(patchPublicationDraft(db, context, draftId, included.revision, {
      type: "inclusion", storyId: "story-1", included: false,
    }, principal)).rejects.toThrow();
    expect(await db.collection(COLLECTIONS.publicationDrafts).findOne({ _id: draftId }))
      .toMatchObject({ revision: included.revision, presentation: { stories: [{ included: true }] } });
  });

  it("never waives factual, source-access or unknown safety holds with arbitrary reasons", async () => {
    const context = (await resolvePublicationContext(db, principal.id, publicationId))!;
    for (const flag of ["summary:unsupported_quote", "source_access_review:denied", "rights_revoked", "unclassified_hold"]) {
      const value = draft();
      value.inclusion_version = 1;
      value.stories[0].review = { status: "held", flags: [flag] };
      value.presentation.stories[0].included = false;
      await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).replaceOne({ _id: draftId }, value);
      await expect(patchPublicationDraft(db, context, draftId, 0, {
        type: "inclusion", storyId: "story-1", included: true, reason: "I approve everything.",
      }, principal)).rejects.toThrow("cannot be overridden");
      const forged = structuredClone(value);
      forged.presentation.stories[0].included = true;
      forged.presentation.stories[0].hold_resolution = {
        reason: "Forged waiver", by: principal, at: 123, flags: [flag],
      };
      await expect(publicationDraftSnapshot(db, context, forged)).rejects.toThrow("cannot be overridden");
    }
  });

  it("migrates a changed legacy selection by revision and invalidates prior approval before publishing", async () => {
    const { context, approved } = await readyAndApprove();
    await db.collection(COLLECTIONS.publicationDrafts).updateOne({ _id: draftId }, {
      $unset: { inclusion_version: "", "presentation.stories.0.included": "" },
      $set: { "stories.0.review": { status: "held", flags: ["summary:too_many_words"] } },
    });
    await expect(publishPublicationDraft(db, memoryStore(), context, draftId,
      approved.approval!.revision, approved.approval!.content_hash, principal)).rejects.toThrow("inclusion changed");
    const stored = await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).findOne({ _id: draftId });
    expect(stored).toMatchObject({ inclusion_version: 1, revision: approved.revision + 1,
      editorial_status: "editing", presentation: { stories: [{ included: false, body: draft().presentation.stories[0].body }] } });
    expect(stored).not.toHaveProperty("approval");
    expect(stored).not.toHaveProperty("publish_claim");
    expect(files.size).toBe(0);
  });

  it("rechecks hard safety at publish and rejects empty included editions", async () => {
    const { context, approved } = await readyAndApprove();
    await db.collection(COLLECTIONS.publicationDrafts).updateOne({ _id: draftId }, {
      $set: { "stories.0.review.flags": ["source_access_review:denied"] },
    });
    await expect(publishPublicationDraft(db, memoryStore(), context, draftId,
      approved.approval!.revision, approved.approval!.content_hash, principal)).rejects.toThrow("cannot be overridden");
    expect(files.size).toBe(0);
    await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).replaceOne({ _id: draftId }, draft());
    const excluded = await patchPublicationDraft(db, context, draftId, 0, {
      type: "inclusion", storyId: "story-1", included: false,
    }, principal);
    await expect(patchPublicationDraft(db, context, draftId, excluded.revision, {
      type: "ready_for_approval",
    }, principal)).rejects.toThrow("at least one story");
    await expect(publicationDraftSnapshot(db, context, excluded)).rejects.toThrow("at least one story");
    const unordered = draft();
    unordered.presentation.section_order = [];
    await expect(publicationDraftSnapshot(db, context, unordered)).rejects.toThrow("valid, ordered section");
    const unresolvedMedia = draft();
    unresolvedMedia.presentation.stories[0].image_review = { status: "needs_review", reason: "No reuse rights." };
    await expect(publicationDraftSnapshot(db, context, unresolvedMedia)).rejects.toThrow("resolve the media review");
    unresolvedMedia.presentation.stories[0].image_review = { status: "removed", reason: "Editor chose no image." };
    expect((await publicationDraftSnapshot(db, context, unresolvedMedia)).items).toHaveLength(1);
  });

  it("supports Mongo-backed immutable artifacts", async () => {
    const folder = mongoChannelFolderId(publicationId);
    await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
      $set: { drive_folder_id: folder },
    });
    const { context, approved } = await readyAndApprove();
    context.publication = (await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId })) as typeof context.publication;
    const unavailableStore = {
      ...memoryStore(),
      saveJson: async () => { throw new Error("External artifact storage must not be used"); },
    };
    const published = await publishPublicationDraft(
      db,
      unavailableStore,
      context,
      draftId,
      approved.approval!.revision,
      approved.approval!.content_hash,
      principal,
    );
    expect(published.release?.artifact_file_id).toBe(`${folder}/publication-release-${published.release.release_id}.json`);
    expect(await db.collection(COLLECTIONS.outputChannelFiles).countDocuments({ folder_id: folder })).toBe(2);
  });
});
