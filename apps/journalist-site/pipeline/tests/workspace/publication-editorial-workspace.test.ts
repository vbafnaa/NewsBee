import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../../accounts/identity";
import { createOutputChannel } from "../../orchestration/output-channels";
import {
  ensurePublicationIndexes,
  resolvePrivilegedPublicationContext,
  resolvePublicationContext,
} from "../../publications/access";
import { publicationAccessAuditIsIntact } from "../../publications/audit";
import {
  createPublicationDraftImage,
  createPublicationInterviewNote,
  deletePublicationInterviewNote,
  listPublicationInterviewNotes,
  patchPublicationDraft,
  PublicationDraftConflict,
  publicationDraftModelInput,
  publicationDraftPreview,
  publicationDraftReadinessErrors,
  publicationEditorialWorkspace,
  updatePublicationInterviewNote,
} from "../../publications/editorial";
import { listPublicationDrafts, publicationGenerationDraft, type PublicationDraft } from "../../publications/generation";
import { includedPublicationStories } from "../../publications/inclusion";
import { COLLECTIONS } from "../../storage/mongo";

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

const owner: Principal = {
  id: "publication-owner",
  email: "owner@example.test",
  role: "owner",
};
const editor: Principal = {
  id: "publication-editor",
  email: "editor@example.test",
  role: "editor",
};
const inspector: Principal = {
  id: "workspace-operator",
  email: "operator@example.test",
  role: "admin",
};
const publicationId = "a".repeat(32);
const otherPublicationId = "b".repeat(32);
const draftId = "guided-draft";
const storyId = "generated-story";
const originalStoryId = "12345678-1234-4123-8123-123456789abc";

function originalStory() {
  return {
    headline: "",
    body: " \r\nUnfinished reporting\n\n",
    byline: "",
    sectionId: "",
    locationTags: [] as string[],
    sourceMetadata: [] as Array<{ type: string; name: string; url?: string; note?: string }>,
  };
}

function draft(): PublicationDraft {
  return {
    _id: draftId,
    publication_id: publicationId,
    generation_id: "guided-generation",
    status: "ready",
    unpublished: true,
    editable: true,
    title: "Independent Weekly · 2026-11-09 to 2026-11-15",
    window: ["2026-11-09", "2026-11-15"],
    locations: [
      { id: "north-wa", name: "North, WA", source_map_version: 11 },
      { id: "south-wa", name: "South, WA", source_map_version: 12 },
    ],
    stories: [{
      id: storyId,
      canonical_identity: "source:https://civic.example.test/story",
      location_tags: [{ id: "north-wa", name: "North, WA" }],
      references: [{
        run_id: "run-north",
        draft_id: "location-draft",
        entry_id: "entry-1",
        story_id: "location-story",
        location_id: "north-wa",
        collected_item_ids: ["item-1"],
      }],
      snapshot: {
        headline: "Council adopts a park plan",
        summary: "The council adopted a plan for the riverside park.",
        when_where: "Nov. 10 at City Hall",
        event_date: "2026-11-10",
        kind: "civic",
        section: "government",
        sources: [{ name: "Council agenda", url: "https://civic.example.test/story" }],
        image: null,
      },
      review: { status: "ready", flags: [] },
    }],
    versions: {
      publication: "publication-version",
      preferences: "preference-version",
      config: "config-version",
      source_maps: [{ location_id: "north-wa", version: 11 }, { location_id: "south-wa", version: 12 }],
    },
    telemetry: { actor: { id: owner.id, email: owner.email }, funding: [] },
    revision: 0,
    editorial_status: "editing",
    presentation: {
      headline: "Independent Weekly",
      intro: "",
      sections: [{ id: "government", title: "Government" }],
      section_order: ["government"],
      stories: [{
        id: storyId,
        origin: "generated",
        generated_story_id: storyId,
        section_id: "government",
        headline: "Council adopts a park plan",
        body: "The council adopted a plan for the riverside park.",
        byline: "",
        location_tags: ["north-wa"],
        source_metadata: [{
          id: "generated-source",
          type: "web",
          name: "Council agenda",
          url: "https://civic.example.test/story",
          note: null,
        }],
        image_id: null,
      }],
      story_order: [storyId],
    },
    updated_at: 1_762_000_000,
    updated_by: { id: owner.id, email: owner.email },
    ready_for_approval_at: null,
    ready_for_approval_by: null,
    distribution: { reader: false, email: false },
    created_at: 1_762_000_000,
  };
}

it("lists same-window drafts and corrections with scoped, bounded history and exact selection", async () => {
  const original = draft();
  await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).insertMany([
    ...Array.from({ length: 52 }, (_, index) => ({
      ...original,
      _id: `retained-${String(index).padStart(2, "0")}`,
      created_at: original.created_at + index + 1,
      ...(index === 51 ? { correction: {
        supersedes_release_id: "immutable-release",
        reason: "Correct a date",
        created_at: original.created_at + 52,
        created_by: owner,
      } } : {}),
    })),
    { ...original, _id: "foreign-draft", publication_id: otherPublicationId, created_at: original.created_at + 100 },
  ]);
  const first = await listPublicationDrafts(db, publicationId);
  expect(first.drafts).toHaveLength(50);
  expect(first.drafts[0]).toMatchObject({ _id: "retained-51", window: original.window, correction: { reason: "Correct a date" } });
  expect(first.drafts[0]).not.toHaveProperty("stories");
  expect(first.drafts[0]).not.toHaveProperty("presentation");
  const second = await listPublicationDrafts(db, publicationId, first.nextCursor);
  expect(second.drafts.map((item) => item._id)).toEqual(["retained-01", "retained-00", draftId]);
  expect(second.nextCursor).toBeNull();
  expect(await publicationGenerationDraft(db, publicationId, draftId)).toMatchObject({ _id: draftId });
  expect(await publicationGenerationDraft(db, publicationId, "foreign-draft")).toBeNull();
  expect(await publicationGenerationDraft(db, publicationId, "missing")).toBeNull();
  await expect(listPublicationDrafts(db, publicationId, '{"created_at":null,"_id":""}')).rejects.toThrow("Invalid draft history cursor");
});

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-editorial-workspace");
});

beforeEach(async () => {
  await db.dropDatabase();
  await createOutputChannel(db, owner.id, publicationId, "publication-folder", {
    name: "Independent Weekly",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: ["north-wa", "south-wa"],
  });

  await createOutputChannel(db, "other-owner", otherPublicationId, "other-folder", {
    name: "Other Weekly",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: ["north-wa"],
  });
  await db.collection(COLLECTIONS.outputChannels).updateOne(
    { _id: publicationId },
    { $set: { members: [{ principal_id: editor.id, role: "editor" }] } },
  );
  await db.collection(COLLECTIONS.publicationDrafts).insertOne(draft());
  await db.collection("collected_items").insertOne({
    _id: "item-1",
    run_id: "run-north",
    location_id: "north-wa",
    source_id: "council",
    source_name: "Council agenda",
    title: "Riverside park agenda item",
    url: "https://civic.example.test/story",
    status: "published",
    reason: null,
    step: "authoring",
    facts: null,
    evidence: {
      policy: "evidence_v1",
      sources: [{
        url: "https://civic.example.test/story",
        final_url: null,
        status: "cached",
        reason: null,
        content_hash: "abc123",
        fetched_at: "2026-11-10T00:00:00.000Z",
        passages: ["The council adopted the plan on Nov. 10."],
      }],
      text_quality: "thin",
      extraction: "complete",
      extraction_error: null,
      missing: [],
    },
    created_at: 1_762_000_000,
  });
  await ensurePublicationIndexes(db, true);
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

describe("publication editorial workspace", () => {
  it("patches subdocuments with compare-and-swap revisions while preserving generated provenance", async () => {
    const context = (await resolvePublicationContext(db, editor.id, publicationId))!;
    const originalSnapshot = (await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).findOne({ _id: draftId }))!.stories;
    let updated = await patchPublicationDraft(db, context, draftId, 0, {
      type: "draft",
      headline: "A better weekly headline",
      intro: "Reporting from North and South this week.",
    }, editor);
    expect(updated).toMatchObject({
      revision: 1,
      presentation: {
        headline: "A better weekly headline",
        intro: "Reporting from North and South this week.",
      },
    });
    updated = await patchPublicationDraft(db, context, draftId, 1, {
      type: "story",
      storyId,
      headline: "Park plan moves forward",
      body: "The council adopted a plan after public testimony.",
      locationTags: ["north-wa", "south-wa"],
    }, editor);
    expect(updated.presentation.stories[0]).toMatchObject({
      headline: "Park plan moves forward",
      location_tags: ["north-wa", "south-wa"],
    });
    await expect(patchPublicationDraft(db, context, draftId, 1, {
      type: "story",
      storyId,
      headline: "Stale overwrite",
    }, owner)).rejects.toBeInstanceOf(PublicationDraftConflict);
    const stored = await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).findOne({ _id: draftId });
    expect(stored?.revision).toBe(2);
    expect(stored?.stories).toEqual(originalSnapshot);
    expect(stored?.presentation.stories[0].headline).toBe("Park plan moves forward");
  });

  it("autosaves incomplete intermediate fields but refuses an incomplete approval handoff", async () => {
    const context = (await resolvePublicationContext(db, editor.id, publicationId))!;
    let updated = await patchPublicationDraft(db, context, draftId, 0, {
      type: "draft",
      headline: "",
      intro: "",
    }, editor);
    updated = await patchPublicationDraft(db, context, draftId, updated.revision, {
      type: "section",
      sectionId: "government",
      title: "",
    }, editor);
    updated = await patchPublicationDraft(db, context, draftId, updated.revision, {
      type: "story",
      storyId,
      headline: "",
      body: "",
      locationTags: [],
    }, editor);
    expect(updated).toMatchObject({
      revision: 3,
      presentation: {
        headline: "",
        intro: "",
        sections: [{ title: "" }],
        stories: [{ headline: "", body: "", location_tags: [] }],
      },
    });
    await expect(patchPublicationDraft(db, context, draftId, updated.revision, {
      type: "ready_for_approval",
    }, editor)).rejects.toThrow("Complete every section title");
  });

  it("adds original reporting, publication-owned images and private notes without leaking notes", async () => {
    const context = (await resolvePublicationContext(db, owner.id, publicationId))!;
    let updated = await patchPublicationDraft(db, context, draftId, 0, {
      type: "draft",
      headline: "Independent Weekly",
      intro: "Original and generated reporting for this week.",
    }, owner);
    updated = await patchPublicationDraft(db, context, draftId, updated.revision, {
      type: "add_original_story",
      storyId: originalStoryId,
      story: {
        headline: "Volunteers restore the creek trail",
        body: "Local volunteers restored two trail segments after interviewing the parks coordinator.",
        byline: "By Jordan Lee",
        sectionId: "government",
        locationTags: ["south-wa"],
        sourceMetadata: [
          { type: "interview", name: "Parks coordinator", note: "Interviewed Nov. 11" },
          { type: "web", name: "Volunteer schedule", url: "https://parks.example.test/volunteer?utm_source=newsbee" },
        ],
      },
    }, owner);
    const original = updated.presentation.stories.find((story) => story.origin === "original")!;
    expect(original.source_metadata[1].url).toBe("https://parks.example.test/volunteer?utm_source=newsbee");

    const attached = await createPublicationDraftImage(db, context, draftId, original.id, updated.revision, {
      image: "https://images.example.test/creek.jpg",
      image_source_url: "https://parks.example.test/gallery",
      image_credit: "Jordan Lee",
      image_caption: "Volunteers clear brush beside the creek trail.",
      image_alt: "Three volunteers clearing brush beside a creek trail.",
      image_date: "2026-11-11",
      image_license: "Used with permission",
      authority: true,
      people_permissions: true,
      permission: { editorial: true, archive: true, crop: true },
    }, owner);
    expect(attached.image).toMatchObject({
      publication_id: publicationId,
      draft_id: draftId,
      story_id: original.id,
      permission: { editorial: true, archive: true, crop: true },
    });

    const createdNote = await createPublicationInterviewNote(db, context, draftId, original.id, attached.draft.revision, {
      interviewee: "Parks coordinator",
      interviewedAt: "2026-11-11",
      body: "Private phone number and unpublished scheduling detail.",
    }, owner);
    const note = createdNote.note;
    await expect(updatePublicationInterviewNote(db, context, draftId, original.id, note._id, createdNote.draft.revision, 1, {
      interviewee: note.interviewee,
      interviewedAt: note.interviewed_at,
      body: note.body,
    }, owner)).rejects.toBeInstanceOf(PublicationDraftConflict);

    const workspace = await publicationEditorialWorkspace(db, context, draftId);
    const preview = publicationDraftPreview(workspace!.draft, workspace!.images);
    const modelInput = publicationDraftModelInput(workspace!.draft);
    for (const value of [workspace, preview, modelInput]) {
      expect(JSON.stringify(value)).not.toContain("Private phone number");
      expect(JSON.stringify(value)).not.toContain("interviewed_at");
    }
    expect(JSON.stringify(workspace)).not.toContain(COLLECTIONS.publicationInterviewNotes);
    expect(preview.sections[0].stories.find((story) => story.id === original.id)?.image).toMatchObject({
      image_credit: "Jordan Lee",
      image_alt: "Three volunteers clearing brush beside a creek trail.",
    });
  });

  describe("original reporting persistence", () => {
    it("persists unfinished original reporting with its identity and exact text, without excluding it", async () => {
      const context = (await resolvePublicationContext(db, editor.id, publicationId))!;
      const story = originalStory();
      const added = await patchPublicationDraft(db, context, draftId, 0, {
        type: "add_original_story", storyId: originalStoryId, story,
      }, editor);
      expect(added.revision).toBe(1);
      const reloaded = (await publicationEditorialWorkspace(db, context, draftId))!.draft;
      expect(reloaded.presentation.stories.at(-1)).toMatchObject({
        id: originalStoryId, origin: "original", included: true, section_id: "",
        headline: "", body: story.body, byline: "", location_tags: [], source_metadata: [],
      });
      expect(reloaded.presentation.story_order).toEqual([storyId, originalStoryId]);
      expect(includedPublicationStories(reloaded).map((story) => story.id)).toContain(originalStoryId);
      expect(publicationDraftReadinessErrors(reloaded, [])).toContain("Every included story requires a valid, ordered section.");
      await expect(patchPublicationDraft(db, context, draftId, 1, {
        type: "ready_for_approval",
      }, editor)).rejects.toThrow("Complete");
      const changed = await patchPublicationDraft(db, context, draftId, 1, {
        type: "story", storyId: originalStoryId,
        headline: "  Developing headline  ", body: "\r\nExact unfinished copy \n", byline: " By ",
        sectionId: "",
        sourceMetadata: [{ type: "web", name: " Source ", url: " https://", note: " Private detail \r\n" }],
      }, editor);
      const saved = (await publicationEditorialWorkspace(db, context, draftId))!.draft.presentation.stories.at(-1)!;
      expect(changed.revision).toBe(2);
      expect(saved).toMatchObject({
        headline: "  Developing headline  ", body: "\r\nExact unfinished copy \n", byline: " By ",
        source_metadata: [{ name: " Source ", url: " https://", note: " Private detail \r\n" }],
      });
      await expect(patchPublicationDraft(db, context, draftId, 1, {
        type: "story", storyId: originalStoryId, body: "A stale overwrite",
      }, editor)).rejects.toBeInstanceOf(PublicationDraftConflict);
    });

    it("replays lost creation responses without duplicate stories, overwrites or resurrecting removals", async () => {
      const context = (await resolvePublicationContext(db, editor.id, publicationId))!;
      const operation = { type: "add_original_story" as const, storyId: originalStoryId, story: {
        ...originalStory(), sourceMetadata: [{ type: "interview", name: "", note: " private " }],
      } };
      const results = await Promise.allSettled([
        patchPublicationDraft(db, context, draftId, 0, operation, editor),
        patchPublicationDraft(db, context, draftId, 0, operation, editor),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      const replay = await patchPublicationDraft(db, context, draftId, 0, operation, editor);
      expect(replay.revision).toBe(1);
      expect(replay.presentation.stories.filter((story) => story.id === originalStoryId)).toHaveLength(1);
      const edited = await patchPublicationDraft(db, context, draftId, replay.revision, {
        type: "story", storyId: originalStoryId, body: "Newer saved copy",
      }, editor);
      const laterReplay = await patchPublicationDraft(db, context, draftId, 0, operation, editor);
      expect(laterReplay.revision).toBe(edited.revision);
      expect(laterReplay.presentation.stories.at(-1)?.body).toBe("Newer saved copy");
      await expect(patchPublicationDraft(db, context, draftId, 0, {
        ...operation, story: { ...operation.story, body: "Different creation" },
      }, editor)).rejects.toBeInstanceOf(PublicationDraftConflict);
      await expect(patchPublicationDraft(db, context, draftId, edited.revision, operation, owner))
        .rejects.toBeInstanceOf(PublicationDraftConflict);
      const removed = await patchPublicationDraft(db, context, draftId, edited.revision, {
        type: "remove_original_story", storyId: originalStoryId,
      }, editor);
      await expect(patchPublicationDraft(db, context, draftId, 0, operation, editor))
        .rejects.toBeInstanceOf(PublicationDraftConflict);
      const stored = (await publicationEditorialWorkspace(db, context, draftId))!.draft;
      expect(stored.revision).toBe(removed.revision);
      expect(stored.presentation.story_order).toEqual([storyId]);
    });

    it("blocks readiness on incomplete original sources until completed, without publishing or leaking source notes", async () => {
      const context = (await resolvePublicationContext(db, editor.id, publicationId))!;
      let updated = await patchPublicationDraft(db, context, draftId, 0, {
        type: "draft", intro: "This week's reporting.",
      }, editor);
      const operation = { type: "add_original_story" as const, storyId: originalStoryId, story: {
        ...originalStory(), headline: "New local reporting", body: "Reporter copy.", byline: "Local reporter",
        sectionId: "government", locationTags: ["north-wa"],
      } };
      updated = await patchPublicationDraft(db, context, draftId, updated.revision, operation, editor);
      await expect(patchPublicationDraft(db, context, draftId, updated.revision, {
        type: "ready_for_approval",
      }, editor)).rejects.toThrow("at least one source");
      for (const source of [
        { type: "web", name: "", url: "" },
        { type: "web", name: "Council", url: "https://" },
        { type: "web", name: "Council", url: "http://civic.example.test" },
      ]) {
        updated = await patchPublicationDraft(db, context, draftId, updated.revision, {
          type: "story", storyId: originalStoryId, sourceMetadata: [source],
        }, editor);
        await expect(patchPublicationDraft(db, context, draftId, updated.revision, {
          type: "ready_for_approval",
        }, editor)).rejects.toThrow();
      }
      updated = await patchPublicationDraft(db, context, draftId, updated.revision, {
        type: "story", storyId: originalStoryId,
        sourceMetadata: [{ type: "web", name: "Council", url: "https://civic.example.test", note: "Private source context" }],
      }, editor);
      const ready = await patchPublicationDraft(db, context, draftId, updated.revision, {
        type: "ready_for_approval",
      }, editor);
      expect(ready.editorial_status).toBe("ready_for_approval");
      expect(ready.release).toBeUndefined();
      expect(ready.distribution).toEqual({ reader: false, email: false });
      expect(JSON.stringify(publicationDraftPreview(ready, []))).not.toContain("Private source context");
      expect(JSON.stringify(publicationDraftModelInput(ready))).not.toContain("original_story_creations");
      await expect(patchPublicationDraft(db, context, draftId, 1, operation, editor)).rejects.toThrow("no longer editable");
    });

    it("still validates original creation identities, sizes, types, sections, locations and current access", async () => {
      const context = (await resolvePublicationContext(db, editor.id, publicationId))!;
      const operation = { type: "add_original_story" as const, storyId: originalStoryId, story: originalStory() };
      for (const invalid of [
        { ...operation, storyId: undefined },
        { ...operation, storyId: ` ${originalStoryId}` },
        { ...operation, storyId: "not-a-uuid" },
        { ...operation, story: { ...operation.story, id: "another-id" } },
        ...[
          { headline: "x".repeat(241) }, { body: "x".repeat(20_001) }, { byline: "x".repeat(241) },
          { headline: 42 }, { body: "unsafe\u0000" }, { sectionId: "foreign-section" },
          { locationTags: ["foreign-location"] }, { sourceMetadata: [{ type: "unknown", name: "" }] },
          { sourceMetadata: [{ type: "web", name: "x".repeat(241) }] },
          { sourceMetadata: [{ type: "web", name: "", url: "x".repeat(4097) }] },
          { sourceMetadata: [{ type: "interview", name: "", note: "x".repeat(1001) }] },
        ].map((fields) => ({ ...operation, story: { ...operation.story, ...fields } })),
      ]) {
        await expect(patchPublicationDraft(db, context, draftId, 0, invalid, editor)).rejects.toThrow();
      }
      expect((await publicationEditorialWorkspace(db, context, draftId))!.draft.revision).toBe(0);
      await patchPublicationDraft(db, context, draftId, 0, operation, editor);
      await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
        $set: { members: [] },
      });
      await expect(patchPublicationDraft(db, context, draftId, 0, operation, editor)).rejects.toThrow();
    });

    it("preserves complete legacy additions without client identity and their exact-revision validation", async () => {
      const context = (await resolvePublicationContext(db, editor.id, publicationId))!;
      const operation = { type: "add_original_story" as const, story: {
        headline: " Complete headline ", body: " Complete body ", byline: " By reporter ",
        sectionId: "government", locationTags: ["north-wa"],
        sourceMetadata: [{ type: "web", name: "Council", url: "https://civic.example.test?utm_source=legacy" }],
      } };
      await expect(patchPublicationDraft(db, context, draftId, 0, {
        ...operation, story: { ...operation.story, byline: "" },
      }, editor)).rejects.toThrow("byline is required");
      const added = await patchPublicationDraft(db, context, draftId, 0, operation, editor);
      expect(added.presentation.stories.at(-1)).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/), headline: "Complete headline", body: "Complete body",
        byline: "By reporter", source_metadata: [{ url: "https://civic.example.test/" }],
      });
      await expect(patchPublicationDraft(db, context, draftId, 0, operation, editor))
        .rejects.toBeInstanceOf(PublicationDraftConflict);
    });
  });

  it("loads evidence in one scoped workspace projection and keeps privileged note inspection audited", async () => {
    const context = (await resolvePublicationContext(db, owner.id, publicationId))!;
    await db.collection(COLLECTIONS.publicationDrafts).updateOne({ _id: draftId }, {
      $set: { "stories.0.review": { status: "held", flags: ["Confirm the implementation date"] } },
    });
    const { note } = await createPublicationInterviewNote(db, context, draftId, storyId, 0, {
      interviewee: "City clerk",
      interviewedAt: "2026-11-10",
      body: "The clerk asked that this unpublished detail remain private.",
    }, owner);
    const workspace = await publicationEditorialWorkspace(db, context, draftId);
    expect(workspace?.evidence[0]).toMatchObject({
      story_id: storyId,
      review: { status: "held", flags: ["Confirm the implementation date"] },
      items: [{ id: "item-1", evidence: { policy: "evidence_v1" } }],
    });
    expect(JSON.stringify(workspace)).not.toContain(note.body);

    const privileged = await resolvePrivilegedPublicationContext(
      db,
      inspector,
      publicationId,
      "Investigate an editor-reported private-note access problem",
    );
    expect(privileged?.role).toBe("privileged");
    expect(await listPublicationInterviewNotes(db, privileged!, draftId, storyId)).toMatchObject([
      { _id: note._id, body: note.body },
    ]);
    const audit = await db.collection(COLLECTIONS.publicationAccessAudit).findOne({ publication_id: publicationId });
    expect(audit).not.toBeNull();
    expect(publicationAccessAuditIsIntact(audit as never)).toBe(true);

    const otherContext = await resolvePublicationContext(db, "other-owner", otherPublicationId);
    expect(await publicationEditorialWorkspace(db, otherContext!, draftId)).toBeNull();
    await expect(listPublicationInterviewNotes(db, otherContext!, draftId, storyId)).rejects.toThrow("not found");
  });

  it("binds note create, update and delete to both draft and note revisions", async () => {
    const context = (await resolvePublicationContext(db, owner.id, publicationId))!;
    const created = await createPublicationInterviewNote(db, context, draftId, storyId, 0, {
      interviewee: "City clerk",
      interviewedAt: "2026-11-10",
      body: "Initial private detail.",
    }, owner);
    expect(created).toMatchObject({ draft: { revision: 1 }, note: { revision: 0 } });

    const updated = await updatePublicationInterviewNote(
      db,
      context,
      draftId,
      storyId,
      created.note._id,
      created.draft.revision,
      created.note.revision,
      {
        interviewee: "City clerk",
        interviewedAt: "2026-11-10",
        body: "Corrected private detail.",
      },
      owner,
    );
    expect(updated).toMatchObject({ draft: { revision: 2 }, note: { revision: 1, body: "Corrected private detail." } });

    await expect(deletePublicationInterviewNote(
      db,
      context,
      draftId,
      storyId,
      created.note._id,
      created.draft.revision,
      updated.note.revision,
      owner,
    )).rejects.toBeInstanceOf(PublicationDraftConflict);
    expect(await db.collection(COLLECTIONS.publicationInterviewNotes).countDocuments({ _id: created.note._id })).toBe(1);

    const deleted = await deletePublicationInterviewNote(
      db,
      context,
      draftId,
      storyId,
      created.note._id,
      updated.draft.revision,
      updated.note.revision,
      owner,
    );
    expect(deleted).toMatchObject({ deleted: true, draft: { revision: 3 } });
    expect(await db.collection(COLLECTIONS.publicationInterviewNotes).countDocuments({ _id: created.note._id })).toBe(0);
  });

  it("cascades original-story notes and images in the same revisioned transaction", async () => {
    const context = (await resolvePublicationContext(db, owner.id, publicationId))!;
    let updated = await patchPublicationDraft(db, context, draftId, 0, {
      type: "add_original_story",
      storyId: originalStoryId,
      story: {
        headline: "Neighbors restore a footbridge",
        body: "Neighbors restored the footbridge after interviewing the parks department.",
        byline: "By Jordan Lee",
        sectionId: "government",
        locationTags: ["south-wa"],
        sourceMetadata: [{ type: "interview", name: "Parks department", note: "Interviewed Nov. 11" }],
      },
    }, owner);
    const original = updated.presentation.stories.find((story) => story.origin === "original")!;
    const attached = await createPublicationDraftImage(db, context, draftId, original.id, updated.revision, {
      image: "https://images.example.test/bridge.jpg",
      image_source_url: "https://parks.example.test/bridge",
      image_credit: "Jordan Lee",
      image_caption: "Neighbors repair a wooden footbridge.",
      image_alt: "Neighbors repairing a wooden footbridge.",
      image_date: "2026-11-11",
      image_license: "Used with permission",
      authority: true,
      people_permissions: true,
      permission: { editorial: true, archive: true, crop: true },
    }, owner);
    const createdNote = await createPublicationInterviewNote(db, context, draftId, original.id, attached.draft.revision, {
      interviewee: "Parks department",
      interviewedAt: "2026-11-11",
      body: "Private bridge inspection detail.",
    }, owner);

    updated = await patchPublicationDraft(db, context, draftId, createdNote.draft.revision, {
      type: "remove_original_story",
      storyId: original.id,
    }, owner);

    expect(updated.presentation.stories.some((story) => story.id === original.id)).toBe(false);
    expect(await db.collection(COLLECTIONS.publicationInterviewNotes).countDocuments({
      publication_id: publicationId,
      draft_id: draftId,
      story_id: original.id,
    })).toBe(0);
    expect(await db.collection(COLLECTIONS.publicationImages).findOne({ _id: attached.image._id })).toMatchObject({
      removed_by: { id: owner.id, email: owner.email },
      removed_at: expect.any(Number),
    });
    await expect(createPublicationInterviewNote(db, context, draftId, original.id, updated.revision, {
      interviewee: "Late source",
      interviewedAt: "2026-11-12",
      body: "This must not become an orphan.",
    }, owner)).rejects.toThrow("Story was not found");
  });

  it("serializes note creation against a concurrent ready transition", async () => {
    const context = (await resolvePublicationContext(db, owner.id, publicationId))!;
    const editable = await patchPublicationDraft(db, context, draftId, 0, {
      type: "draft",
      intro: "A complete draft awaiting another editor.",
    }, owner);
    const results = await Promise.allSettled([
      createPublicationInterviewNote(db, context, draftId, storyId, editable.revision, {
        interviewee: "City clerk",
        interviewedAt: "2026-11-10",
        body: "A private detail racing the approval lock.",
      }, owner),
      patchPublicationDraft(db, context, draftId, editable.revision, {
        type: "ready_for_approval",
      }, owner),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const stored = await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).findOne({ _id: draftId });
    const noteCount = await db.collection(COLLECTIONS.publicationInterviewNotes).countDocuments({ draft_id: draftId });
    if (stored?.editorial_status === "ready_for_approval") {
      expect(noteCount).toBe(0);
    } else {
      expect(stored?.editorial_status).toBe("editing");
      expect(noteCount).toBe(1);
    }
  });

  it("marks a complete draft ready for approval without publishing or distributing", async () => {
    const context = (await resolvePublicationContext(db, owner.id, publicationId))!;
    let updated = await patchPublicationDraft(db, context, draftId, 0, {
      type: "draft",
      headline: "Independent Weekly",
      intro: "A complete draft awaiting another editor.",
    }, owner);
    updated = await patchPublicationDraft(db, context, draftId, updated.revision, {
      type: "ready_for_approval",
    }, owner);
    expect(updated).toMatchObject({
      editorial_status: "ready_for_approval",
      revision: 2,
      distribution: { reader: false, email: false },
      ready_for_approval_by: { id: owner.id, email: owner.email },
    });
    await expect(patchPublicationDraft(db, context, draftId, updated.revision, {
      type: "draft",
      headline: "Should not save",
    }, owner)).rejects.toThrow("no longer editable");
    expect(await db.collection(COLLECTIONS.outputChannelEditions).countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.outputChannelFiles).countDocuments()).toBe(0);
    expect(await db.collection("email_outbox").countDocuments()).toBe(0);
  });
});
