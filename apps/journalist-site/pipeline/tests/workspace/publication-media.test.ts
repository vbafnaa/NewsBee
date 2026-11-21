import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ILLUSTRATIONS, ILLUSTRATION_POLICY, planIllustrations } from "../../../../../shared/editorial-illustrations";
import { PHOTO_ASSETS } from "../../../../../shared/image-assets";
import { parsePublicationRelease } from "../../../../../shared/publication-release";
import type { StoryImage } from "../../../../../shared/story-image";
import type { Principal } from "../../accounts/identity";
import { publishableStoryImage } from "../../images/pipeline";
import { ensurePublicationIndexes, type PublicationContext } from "../../publications/access";
import {
  createPublicationDraftImage,
  patchPublicationDraft,
  publicationEditorialWorkspace,
  removePublicationDraftImage,
} from "../../publications/editorial";
import type { PublicationDraft } from "../../publications/generation";
import {
  generatedImageSnapshot,
  generatedPublicationImages,
  publicationImageEligible,
} from "../../publications/media";
import { createPublicationCorrection, publicationDraftSnapshot } from "../../publications/releases";
import { COLLECTIONS } from "../../storage/mongo";
import { pipelineEdition } from "../../../../reader-site/src/lib/edition-view";
import type { Edition } from "../../../../reader-site/src/lib/reader-data";

vi.mock("../../images/pipeline", () => ({ publishableStoryImage: vi.fn() }));

const principal = { id: "owner", email: "owner@example.test", role: "owner" } as Principal;
const context: PublicationContext = {
  id: "publication", principalId: principal.id, ownerId: principal.id, role: "owner",
  publication: {
    _id: "publication", owner_id: principal.id, name: "Weekly", publication_scope_version: 1,
  },
};
const photo: StoryImage = {
  image: "https://photos.example.test/park.jpg",
  image_source_url: "https://parks.example.test/gallery",
  image_credit: "Jordan Lee",
  image_alt: "An empty park beside the creek.",
  image_caption: "Creek park in November.",
  image_date: "2026-11-01",
  image_license: "CC BY 4.0",
  image_license_url: "https://creativecommons.org/licenses/by/4.0/",
};
const result = () => ({
  image: structuredClone(photo),
  image_pipeline: { status: "selected", policy: "reviewed-policy", provider: "publisher" },
  image_caption: "Saved caption",
  image_credit: "Saved credit",
});

function draft(): PublicationDraft {
  const story = {
    id: "story", origin: "generated" as const, generated_story_id: "story", section_id: "news",
    headline: "Park improvements", body: "The council approved park improvements.", byline: "",
    location_tags: ["north"], source_metadata: [], image_id: null, included: true,
  };
  return {
    _id: "draft", publication_id: context.id, generation_id: "generation",
    status: "ready", unpublished: true, editable: true, title: "Weekly", window: ["2026-11-01", "2026-11-07"],
    locations: [{ id: "north", name: "North", source_map_version: 1 }],
    stories: [{
      id: "story", canonical_identity: "source:park", location_tags: [{ id: "north", name: "North" }],
      references: [{ run_id: "run", draft_id: "edition", entry_id: "entry", story_id: "source-story", location_id: "north", collected_item_ids: [] }],
      snapshot: {
        headline: story.headline, summary: story.body, when_where: null, event_date: null,
        kind: "local_news", section: "news", sources: [], image: generatedImageSnapshot(result()),
      },
      review: { status: "ready", flags: [] },
    }],
    versions: { publication: "1", preferences: "1", config: "1", source_maps: [] },
    telemetry: { actor: principal, funding: [] }, revision: 0, editorial_status: "editing", inclusion_version: 1,
    presentation: { headline: "Weekly", intro: "Local reporting.", sections: [{ id: "news", title: "News" }], section_order: ["news"], stories: [story], story_order: ["story"] },
    updated_at: 1, updated_by: principal, ready_for_approval_at: null, ready_for_approval_by: null,
    distribution: { reader: false, email: false }, created_at: 1,
  };
}

function memoryDb() {
  let tables: Record<string, any[]> = {
    [COLLECTIONS.outputChannels]: [structuredClone(context.publication)],
  };
  const state = { failCollection: "", conflictDraft: false, retryTransaction: false };
  const field = (row: any, path: string) => path.split(".").reduce((value, key) => value?.[key], row);
  const matches = (row: any, filter: any): boolean => Object.entries(filter).every(([key, value]) => {
    if (key === "$and") return (value as any[]).every((part) => matches(row, part));
    if (key === "$or") return (value as any[]).some((part) => matches(row, part));
    const actual = field(row, key);
    if (value && typeof value === "object") {
      if ("$in" in value) return (value.$in as unknown[]).includes(actual);
      if ("$exists" in value) return (actual !== undefined) === value.$exists;
    }
    return actual === value;
  });
  const update = (row: any, operation: any) => {
    for (const [path, value] of Object.entries(operation.$set ?? {})) {
      const keys = path.split(".");
      const key = keys.pop()!;
      let target = row;
      for (const part of keys) target = target[part] ??= {};
      target[key] = structuredClone(value);
    }
    for (const [key, value] of Object.entries(operation.$inc ?? {})) row[key] += Number(value);
  };
  const db = {
    client: {
      startSession: () => ({
        withTransaction: async (handler: () => Promise<unknown>) => {
          const before = structuredClone(tables);
          try {
            if (state.retryTransaction) {
              state.retryTransaction = false;
              await handler();
              tables = structuredClone(before);
            }
            return await handler();
          } catch (error) {
            tables = before;
            throw error;
          }
        },
        endSession: async () => {},
      }),
    },
    collection: (name: string) => ({
      createIndex: async () => "",
      createIndexes: async () => [],
      indexExists: async () => false,
      dropIndex: async () => {},
      findOne: async (filter: any) => structuredClone((tables[name] ?? []).find((row) => matches(row, filter)) ?? null),
      find: (filter: any) => {
        const cursor = { sort: () => cursor, toArray: async () => structuredClone((tables[name] ?? []).filter((row) => matches(row, filter))) };
        return cursor;
      },
      insertOne: async (row: any) => {
        if (state.failCollection === name) throw new Error("Injected write failure");
        (tables[name] ??= []).push(structuredClone(row));
      },
      insertMany: async (rows: any[]) => {
        if (state.failCollection === name) throw new Error("Injected write failure");
        (tables[name] ??= []).push(...structuredClone(rows));
      },
      findOneAndUpdate: async (filter: any, operation: any, options: any) => {
        if (state.conflictDraft && name === COLLECTIONS.publicationDrafts) return null;
        const row = (tables[name] ?? []).find((candidate) => matches(candidate, filter));
        if (!row) return null;
        const before = structuredClone(row);
        update(row, operation);
        return structuredClone(options.returnDocument === "after" ? row : before);
      },
    }),
  } as unknown as Db;
  return {
    db, state,
    seed: (name: string, ...rows: unknown[]) => { tables[name] = structuredClone(rows); },
    rows: (name: string) => structuredClone(tables[name] ?? []),
  };
}

function seedEntry(memory: ReturnType<typeof memoryDb>, value: Record<string, any> = result()) {
  memory.seed(COLLECTIONS.editionEntries, {
    id: "entry", edition_id: "edition", story_id: "source-story", source_id: "source", disposition: "checks_passed", result: value,
  });
}

function seedIllustration(memory: ReturnType<typeof memoryDb>) {
  const source = draft();
  const item = {
    story_id: "source-story", headline: "Library opens a reading room",
    blurb: "The library opens a neighborhood room for reading and books.", kind: "local_news", rank: 1,
  };
  const illustration = planIllustrations([item], "north").get(0)!;
  const value = {
    story: { kind: item.kind }, draft: { headline: item.headline, summary: item.blurb }, illustration,
    image_pipeline: { status: "illustrated", policy: ILLUSTRATION_POLICY, provider: "newsbee_ai" },
  };
  source.stories[0].snapshot.image = generatedImageSnapshot(value);
  const published = {
    media_mode: "illustrated",
    items: [{ ...item, illustration_id: illustration.id, illustration_asset_id: illustration.asset_id ?? illustration.id, illustration_policy: illustration.policy }],
  };
  const edition = { id: "edition", location_id: "north", status: "built", published };
  seedEntry(memory, value);
  memory.seed(COLLECTIONS.editions, edition);
  return { source, illustration, edition };
}

async function seedPublished(memory: ReturnType<typeof memoryDb>) {
  const source = draft();
  seedEntry(memory);
  const rows = await generatedPublicationImages(memory.db, source);
  source.editorial_status = "published";
  source.release = { release_id: "release", content_hash: "hash" } as PublicationDraft["release"];
  memory.seed(COLLECTIONS.publicationDrafts, source);
  memory.seed(COLLECTIONS.publicationImages, ...rows);
  return { source, image: rows[0] };
}

beforeEach(() => {
  vi.mocked(publishableStoryImage).mockReset();
  vi.mocked(publishableStoryImage).mockResolvedValue(structuredClone(photo));
});

describe("publication media ownership", () => {
  it("migrates the legacy sparse release index while retaining scoped release uniqueness", async () => {
    const dbPath = path.resolve("pipeline", "tests", `.publication-media-index-${randomUUID()}`);
    let server: MongoMemoryServer | undefined;
    let client: MongoClient | undefined;
    vi.stubEnv("MONGOMS_RUNTIME_DOWNLOAD", "false");
    try {
      await mkdir(dbPath, { recursive: true });
      server = await MongoMemoryServer.create({ instance: { dbPath } });
      client = await MongoClient.connect(server.getUri());
      const db = client.db("publication-media-index-migration");
      const drafts = db.collection<{ _id: string; publication_id: string; release?: { release_id: string } }>(COLLECTIONS.publicationDrafts);
      await drafts.createIndex({ publication_id: 1, "release.release_id": 1 }, {
        name: "publication_release_identity", unique: true, sparse: true,
      });
      await drafts.insertOne({ _id: "unpublished-1", publication_id: context.id });
      await expect(drafts.insertOne({ _id: "unpublished-2", publication_id: context.id }))
        .rejects.toMatchObject({ code: 11000 });

      await ensurePublicationIndexes(db);

      const indexes = await drafts.indexes();
      expect(indexes.some((index) => index.name === "publication_release_identity")).toBe(false);
      expect(indexes.find((index) => index.unique && index.partialFilterExpression?.["release.release_id"]))
        .toMatchObject({ partialFilterExpression: { "release.release_id": { $type: "string" } } });
      await drafts.insertOne({ _id: "unpublished-2", publication_id: context.id });
      expect(await drafts.countDocuments({ publication_id: context.id, release: { $exists: false } })).toBe(2);
      await drafts.insertOne({ _id: "released-1", publication_id: context.id, release: { release_id: "release-1" } });
      await expect(drafts.insertOne({ _id: "released-duplicate", publication_id: context.id, release: { release_id: "release-1" } }))
        .rejects.toMatchObject({ code: 11000 });
      await drafts.insertOne({ _id: "released-other-publication", publication_id: "other-publication", release: { release_id: "release-1" } });
    } finally {
      await client?.close();
      await server?.stop();
      await rm(dbPath, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 120_000);

  it("preserves nested snapshots and binds only a currently reviewed selection without inventing human permission", async () => {
    const memory = memoryDb();
    const generated = draft();
    const snapshot = structuredClone(generated.stories[0].snapshot.image);
    expect(generated.presentation.stories[0].image_id).toBeNull();
    seedEntry(memory);
    const rows = await generatedPublicationImages(memory.db, generated);
    expect(rows).toHaveLength(1);
    expect(rows[0].image).toEqual(photo);
    expect(rows[0].authority_confirmed).toBeUndefined();
    expect(rows[0].permission).toBeUndefined();
    expect(rows[0].provenance?.reference).toEqual({ draft_id: "edition", story_id: "source-story", location_id: "north", source_id: "source" });
    expect(generated.presentation.stories[0].image_id).toBe(rows[0]._id);
    expect(generated.stories[0].snapshot.image).toEqual(snapshot);
    expect(snapshot).toMatchObject({ image: photo, pipeline: { status: "selected" }, caption: "Saved caption", credit: "Saved credit" });

    vi.mocked(publishableStoryImage).mockResolvedValue(null);
    const unreviewed = draft();
    expect(await generatedPublicationImages(memory.db, unreviewed)).toEqual([]);
    expect(unreviewed.presentation.stories[0]).toMatchObject({ image_id: null, image_review: { status: "needs_review" } });
    expect(unreviewed.stories[0].snapshot.image).toEqual(snapshot);
  });

  it("preserves illustration provenance for visible review rather than fabricating a photo grant", async () => {
    const memory = memoryDb();
    const illustration = ILLUSTRATIONS.find((art) => art.id === "civic")!;
    const value = {
      story: { kind: "local_news" }, draft: { headline: "Council approves park improvements" },
      illustration: { id: illustration.id, policy: ILLUSTRATION_POLICY, alt: illustration.alt },
      image_pipeline: { status: "illustrated", policy: ILLUSTRATION_POLICY },
    };
    const generated = draft();
    generated.stories[0].snapshot.image = generatedImageSnapshot(value);
    seedEntry(memory, value);
    memory.seed(COLLECTIONS.editions, { id: "edition", location_id: "north" });
    const rows = await generatedPublicationImages(memory.db, generated);
    expect(rows).toEqual([]);
    expect(generated.presentation.stories[0]).toMatchObject({ image_id: null, image_review: { status: "needs_review" } });
    expect(generated.stories[0].snapshot.image).toMatchObject({ illustration: value.illustration, pipeline: value.image_pipeline });
    expect(publishableStoryImage).not.toHaveBeenCalled();
  });

  it("binds actual reviewed canonical illustration allocations and rebinds them intact for corrections", async () => {
    const memory = memoryDb();
    const { source, illustration, edition } = seedIllustration(memory);
    const rows = await generatedPublicationImages(memory.db, source);
    expect(rows).toHaveLength(1);
    expect(rows[0].illustration).toEqual({ ...illustration, asset_id: illustration.asset_id ?? illustration.id });
    expect(rows[0].image).toMatchObject({
      image: `/reader/illustrations/${illustration.asset_id ?? illustration.id}-v1.webp`,
      image_alt: illustration.alt, image_credit: "Newsbee · AI-generated illustration",
    });
    expect(rows[0].authority_confirmed).toBeUndefined();
    expect(rows[0].permission).toBeUndefined();
    expect(rows[0].image.image_caption).toContain("does not depict the actual");
    memory.seed(COLLECTIONS.publicationImages, ...rows);
    const snapshot = await publicationDraftSnapshot(memory.db, context, source);
    expect(snapshot.items[0]).toMatchObject({
      illustration_id: illustration.id, illustration_asset_id: illustration.asset_id ?? illustration.id,
      illustration_policy: ILLUSTRATION_POLICY, image_alt: illustration.alt,
    });
    expect(snapshot.items[0].image).toBeUndefined();
    const release = {
      ...snapshot, release_id: "release",
      publication: { id: context.id, profile_revision: 0, display_name: "Weekly", description: null, homepage_url: null, logo_url: null },
      sponsor_placements: { revision: 0, placements: [] },
      approval: { draft_revision: 0, draft_content_hash: "hash", approved_by: principal, approved_at: 1 },
      published_by: principal, published_at: 1,
    };
    expect(parsePublicationRelease(release)?.items[0].illustration_asset_id).toBe(illustration.asset_id ?? illustration.id);
    expect(parsePublicationRelease({
      ...release, items: [{ ...snapshot.items[0], illustration_asset_id: "unreviewed-asset" }],
    })).toBeNull();
    source.editorial_status = "published";
    source.release = { release_id: "release", content_hash: "hash" } as PublicationDraft["release"];
    memory.seed(COLLECTIONS.publicationDrafts, source);
    const correction = await createPublicationCorrection(memory.db, context, "release", "Correct the wording.", principal);
    expect(correction.presentation.stories[0].image_id).not.toBe(rows[0]._id);
    const copied = memory.rows(COLLECTIONS.publicationImages).find((row) => row._id === correction.presentation.stories[0].image_id);
    expect(copied.illustration).toEqual(rows[0].illustration);
    expect(copied.provenance).toEqual(rows[0].provenance);
    expect((await publicationDraftSnapshot(memory.db, context, correction)).items).toEqual(snapshot.items);

    memory.seed(COLLECTIONS.editions, {
      ...edition,
      published: { ...edition.published, items: [{ ...edition.published.items[0], illustration_asset_id: "unreviewed-asset" }] },
    });
    expect(await publicationImageEligible(memory.db, rows[0])).toBe(false);
    const invalid = structuredClone(source);
    invalid.presentation.stories[0].image_id = null;
    expect(await generatedPublicationImages(memory.db, invalid)).toEqual([]);
    expect(invalid.presentation.stories[0].image_review?.status).toBe("needs_review");
    expect(publishableStoryImage).not.toHaveBeenCalled();
  });

  it("renders frozen publication artwork alongside photos without reallocating removed or replaced media", async () => {
    const memory = memoryDb();
    const { source, illustration } = seedIllustration(memory);
    memory.seed(COLLECTIONS.publicationImages, ...await generatedPublicationImages(memory.db, source));
    const snapshot = await publicationDraftSnapshot(memory.db, context, source);
    const item = snapshot.items[0];
    const withoutArt = { ...item, illustration_id: undefined, illustration_asset_id: undefined, illustration_policy: undefined };
    const edition = {
      id: "release", publication_release: true, location_id: context.id, location_name: "Weekly",
      media_mode: "photos", window_start: source.window[0], window_end: source.window[1], published_at: 1,
      headline: "Weekly", intro: "", sections: [{ id: "news", title: "News" }],
      items: [
        { ...item, headline: "Council budget update" },
        { ...withoutArt, ...photo, item_id: "replacement", story_id: "replacement" },
        { ...withoutArt, item_id: "removed", story_id: "removed", headline: "Library holds book reading" },
      ],
    } as Edition;
    const reader = pipelineEdition(edition);
    expect(reader.topStories[0].illustration).toEqual({ ...illustration, asset_id: illustration.asset_id ?? illustration.id });
    expect(reader.topStories[1].illustration).toBeUndefined();
    expect(reader.topStories[1].photo?.src).toBe(photo.image);
    expect(reader.topStories[2].illustration).toBeUndefined();
    expect(reader.topStories[2].photo).toBeUndefined();
    vi.stubEnv("NEWSBEE_READER_MEDIA_MODE", "none");
    try {
      expect(pipelineEdition(edition).topStories.every((story) => !story.illustration && !story.photo)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rechecks revoked rights and missing immutable bytes in workspace and release snapshots", async () => {
    const memory = memoryDb();
    const { source, image } = await seedPublished(memory);
    vi.mocked(publishableStoryImage).mockResolvedValue(null);
    const workspace = await publicationEditorialWorkspace(memory.db, context, source._id);
    expect(workspace?.images).toEqual([]);
    expect(workspace?.draft.presentation.stories[0].image_review?.status).toBe("needs_review");
    await expect(publicationDraftSnapshot(memory.db, context, source)).rejects.toThrow("current rights are unavailable");
    const assetImage = { ...image, image: { ...photo, image_asset_id: "a".repeat(64) } };
    vi.mocked(publishableStoryImage).mockResolvedValue(assetImage.image);
    expect(await publicationImageEligible(memory.db, assetImage)).toBe(false);
    memory.seed(PHOTO_ASSETS, {
      _id: assetImage.image.image_asset_id, variants: [
        { id: "desktop", layout: "desktop", width: 960 }, { id: "mobile", layout: "mobile", width: 480 },
      ],
    });
    memory.seed(`${PHOTO_ASSETS}_blobs`, ...["desktop", "mobile"].map((_id) => ({
      _id, bytes: new Uint8Array([1]), content_type: "image/webp", width: 960, height: 640,
    })));
    expect(await publicationImageEligible(memory.db, assetImage)).toBe(true);
  });

  it("explicitly clears unresolved missing or revoked bindings without requiring the unavailable image record", async () => {
    for (const mode of ["missing", "revoked"]) {
      vi.mocked(publishableStoryImage).mockResolvedValue(photo);
      const memory = memoryDb();
      const { source, image } = await seedPublished(memory);
      const correction = await createPublicationCorrection(memory.db, context, "release", "Correct the wording.", principal);
      if (mode === "missing") memory.seed(COLLECTIONS.publicationImages, image);
      else vi.mocked(publishableStoryImage).mockResolvedValue(null);
      const workspace = await publicationEditorialWorkspace(memory.db, context, correction._id);
      expect(workspace?.images).toEqual([]);
      expect(workspace?.draft.presentation.stories[0]).toMatchObject({
        image_id: correction.presentation.stories[0].image_id,
        image_review: { status: "needs_review" },
      });
      const removed = await patchPublicationDraft(memory.db, context, correction._id, 0, {
        type: "story", storyId: "story", imageId: null,
      }, principal);
      expect(removed.presentation.stories[0]).toMatchObject({ image_id: null, image_review: { status: "removed" } });
      expect(removed.revision).toBe(1);
      expect(memory.rows(COLLECTIONS.publicationDrafts).find((row) => row._id === source._id)).toEqual(source);
      expect(memory.rows(COLLECTIONS.publicationImages).find((row) => row._id === image._id)).toEqual(image);
    }
  });

  it("atomically rebinds correction-owned images, preserving originals through replacement and removal", async () => {
    const memory = memoryDb();
    const { source, image } = await seedPublished(memory);
    memory.state.retryTransaction = true;
    const correction = await createPublicationCorrection(memory.db, context, "release", "Correct the wording.", principal);
    const copyId = correction.presentation.stories[0].image_id;
    expect(copyId).toBeTruthy();
    expect(copyId).not.toBe(image._id);
    const copy = memory.rows(COLLECTIONS.publicationImages).find((row) => row._id === copyId);
    expect(copy).toMatchObject({
      draft_id: correction._id, story_id: "story", image: photo, provenance: image.provenance,
      copied_from: { image_id: image._id, draft_id: source._id },
    });
    expect((await publicationDraftSnapshot(memory.db, context, correction)).items[0]).toMatchObject(photo);
    const replacement = await createPublicationDraftImage(memory.db, context, correction._id, "story", 0, {
      ...photo, image: "https://photos.example.test/replacement.jpg",
      authority: true, people_permissions: true, editorial: true, archive: true, crop: true,
    }, principal);
    expect(replacement.draft.presentation.stories[0].image_id).toBe(replacement.image._id);
    const removed = await removePublicationDraftImage(memory.db, context, correction._id, replacement.image._id, 1, principal);
    expect(removed.presentation.stories[0]).toMatchObject({ image_id: null, image_review: { status: "removed" } });
    expect((await publicationDraftSnapshot(memory.db, context, removed)).items[0].image).toBeUndefined();
    expect(memory.rows(COLLECTIONS.publicationImages).find((row) => row._id === image._id)).toEqual(image);
    expect(memory.rows(COLLECTIONS.publicationDrafts).find((row) => row._id === source._id)).toEqual(source);
  });

  it("clears ineligible correction media visibly instead of copying foreign, missing or revoked records", async () => {
    const memory = memoryDb();
    const { source, image } = await seedPublished(memory);
    for (const mode of ["revoked", "foreign", "missing"] as const) {
      vi.mocked(publishableStoryImage).mockResolvedValue(mode === "revoked" ? null : photo);
      memory.seed(COLLECTIONS.publicationDrafts, source);
      memory.seed(COLLECTIONS.publicationImages, ...(mode === "missing" ? [] : [{ ...image, publication_id: mode === "foreign" ? "another-publication" : context.id }]));
      const correction = await createPublicationCorrection(memory.db, context, "release", "Correct the wording.", principal);
      expect(correction.presentation.stories[0]).toMatchObject({ image_id: null, image_review: { status: "needs_review" } });
      expect(memory.rows(COLLECTIONS.publicationImages)).toHaveLength(mode === "missing" ? 0 : 1);
    }
  });

  it("rolls back correction clones and image insert/removal when the whole revisioned operation fails", async () => {
    const memory = memoryDb();
    const { source, image } = await seedPublished(memory);
    memory.state.failCollection = COLLECTIONS.publicationAccessAudit;
    await expect(createPublicationCorrection(memory.db, context, "release", "Correct the wording.", principal)).rejects.toThrow("Injected");
    expect(memory.rows(COLLECTIONS.publicationDrafts)).toEqual([source]);
    expect(memory.rows(COLLECTIONS.publicationImages)).toEqual([image]);
    memory.state.failCollection = "";
    const correction = await createPublicationCorrection(memory.db, context, "release", "Correct the wording.", principal);
    const before = memory.rows(COLLECTIONS.publicationImages);
    memory.state.conflictDraft = true;
    await expect(createPublicationDraftImage(memory.db, context, correction._id, "story", 0, {
      ...photo, authority: true, people_permissions: true, editorial: true, archive: true, crop: true,
    }, principal)).rejects.toThrow("draft changed");
    expect(memory.rows(COLLECTIONS.publicationImages)).toEqual(before);
    await expect(removePublicationDraftImage(memory.db, context, correction._id, correction.presentation.stories[0].image_id!, 0, principal)).rejects.toThrow("draft changed");
    expect(memory.rows(COLLECTIONS.publicationImages)).toEqual(before);
    memory.state.conflictDraft = false;
    const dismissed = await patchPublicationDraft(memory.db, context, correction._id, 0, { type: "story", storyId: "story", imageId: null }, principal);
    expect(dismissed.presentation.stories[0]).toMatchObject({ image_id: null, image_review: { status: "removed" } });
  });
});
