import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createOutputChannel } from "../pipeline/orchestration/output-channels";
import { resolvePublicationContext } from "../pipeline/publications/access";
import {
  createPublicationDraftImage,
  createPublicationInterviewNote,
  patchPublicationDraft,
  PublicationDraftConflict,
  publicationDraftModelInput,
  publicationDraftPreview,
  publicationEditorialWorkspace,
} from "../pipeline/publications/editorial";
import type { PublicationDraft } from "../pipeline/publications/generation";
import { COLLECTIONS } from "../pipeline/storage/mongo";

const principal = {
  id: "local-editor",
  email: "local-editor@example.test",
  role: "owner" as const,
};
const publicationId = "d".repeat(32);
const otherPublicationId = "e".repeat(32);
const draftId = "local-editorial-draft";
const generatedStoryId = "local-generated-story";

function seedDraft(): PublicationDraft {
  return {
    _id: draftId,
    publication_id: publicationId,
    generation_id: "local-guided-generation",
    status: "ready",
    unpublished: true,
    editable: true,
    title: "Local Weekly",
    window: ["2026-11-09", "2026-11-15"],
    locations: [
      { id: "north-wa", name: "North, WA", source_map_version: 1 },
      { id: "south-wa", name: "South, WA", source_map_version: 2 },
    ],
    stories: [{
      id: generatedStoryId,
      canonical_identity: "story:local-generated",
      location_tags: [{ id: "north-wa", name: "North, WA" }],
      references: [],
      snapshot: {
        headline: "Library expands weekend hours",
        summary: "The library added Sunday afternoon hours.",
        when_where: "Sundays at the main branch",
        event_date: "2026-11-15",
        kind: "civic",
        section: "community",
        sources: [{ name: "Library notice", url: "https://library.example.test/hours" }],
        image: null,
      },
      review: { status: "ready", flags: [] },
    }],
    versions: {
      publication: "local-publication",
      preferences: "local-preferences",
      config: "local-config",
      source_maps: [{ location_id: "north-wa", version: 1 }, { location_id: "south-wa", version: 2 }],
    },
    telemetry: { actor: { id: principal.id, email: principal.email }, funding: [] },
    revision: 0,
    editorial_status: "editing",
    presentation: {
      headline: "Local Weekly",
      intro: "",
      sections: [{ id: "community", title: "Community" }],
      section_order: ["community"],
      stories: [{
        id: generatedStoryId,
        origin: "generated",
        generated_story_id: generatedStoryId,
        section_id: "community",
        headline: "Library expands weekend hours",
        body: "The library added Sunday afternoon hours.",
        byline: "",
        location_tags: ["north-wa"],
        source_metadata: [{ id: "library-source", type: "web", name: "Library notice", url: "https://library.example.test/hours", note: null }],
        image_id: null,
      }],
      story_order: [generatedStoryId],
    },
    updated_at: Date.now() / 1000,
    updated_by: { id: principal.id, email: principal.email },
    ready_for_approval_at: null,
    ready_for_approval_by: null,
    distribution: { reader: false, email: false },
    created_at: Date.now() / 1000,
  };
}

const server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
const client = await MongoClient.connect(server.getUri());
try {
  const db = client.db("newsbee-editorial-local");
  await createOutputChannel(db, principal.id, publicationId, "local-publication-folder", {
    name: "Local Weekly",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: ["north-wa", "south-wa"],
  });
  await createOutputChannel(db, "other-owner", otherPublicationId, "other-publication-folder", {
    name: "Other Weekly",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: ["north-wa"],
  });
  await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).insertOne(seedDraft());
  const context = (await resolvePublicationContext(db, principal.id, publicationId))!;

  let edited = await patchPublicationDraft(db, context, draftId, 0, {
    type: "draft",
    headline: "North and South Weekly",
    intro: "A reviewed edition combining community and original reporting.",
  }, principal);
  edited = await patchPublicationDraft(db, context, draftId, edited.revision, {
    type: "story",
    storyId: generatedStoryId,
    headline: "Library opens on Sunday afternoons",
    body: "The main branch will open on Sunday afternoons beginning this week.",
    locationTags: ["north-wa", "south-wa"],
  }, principal);
  edited = await patchPublicationDraft(db, context, draftId, edited.revision, {
    type: "add_original_story",
    story: {
      headline: "Students map safer walking routes",
      body: "Students and families mapped safer routes after an original interview with the crossing guard.",
      byline: "By Local Editor",
      sectionId: "community",
      locationTags: ["south-wa"],
      sourceMetadata: [{ type: "interview", name: "School crossing guard", note: "Interviewed Nov. 11" }],
    },
  }, principal);
  const original = edited.presentation.stories.find((story) => story.origin === "original")!;
  const attached = await createPublicationDraftImage(db, context, draftId, original.id, edited.revision, {
    image: "https://images.example.test/walking-routes.jpg",
    image_source_url: "https://schools.example.test/gallery",
    image_credit: "Local Editor",
    image_caption: "Students mark a neighborhood walking route on a paper map.",
    image_alt: "Students marking a neighborhood walking route on a paper map.",
    image_date: "2026-11-11",
    image_license: "Used with permission",
    authority: true,
    people_permissions: true,
    permission: { editorial: true, archive: true, crop: true },
  }, principal);
  const createdNote = await createPublicationInterviewNote(db, context, draftId, original.id, attached.draft.revision, {
    interviewee: "School crossing guard",
    interviewedAt: "2026-11-11",
    body: "Private contact details and an unpublished follow-up idea.",
  }, principal);

  await assert.rejects(
    patchPublicationDraft(db, context, draftId, edited.revision, {
      type: "draft",
      headline: "A stale overwrite",
    }, principal),
    PublicationDraftConflict,
  );
  const ready = await patchPublicationDraft(db, context, draftId, createdNote.draft.revision, {
    type: "ready_for_approval",
  }, principal);
  const workspace = await publicationEditorialWorkspace(db, context, draftId);
  const preview = publicationDraftPreview(ready, workspace!.images);
  const modelInput = publicationDraftModelInput(ready);
  assert.equal(ready.editorial_status, "ready_for_approval");
  assert.equal(await db.collection(COLLECTIONS.outputChannelEditions).countDocuments(), 0);
  assert.equal(await db.collection(COLLECTIONS.outputChannelFiles).countDocuments(), 0);
  assert.equal(await db.collection("email_outbox").countDocuments(), 0);
  assert.equal(JSON.stringify(preview).includes("Private contact details"), false);
  assert.equal(JSON.stringify(modelInput).includes("Private contact details"), false);
  assert.equal(JSON.stringify(workspace).includes("Private contact details"), false);
  assert.equal(await publicationEditorialWorkspace(
    db,
    (await resolvePublicationContext(db, "other-owner", otherPublicationId))!,
    draftId,
  ), null);

  console.log(JSON.stringify({
    result: "ok",
    draft: ready._id,
    revision: ready.revision,
    status: ready.editorial_status,
    stories: ready.presentation.stories.length,
    image: attached.image._id,
    publication_isolated: true,
    private_notes_excluded: true,
    distribution_writes: 0,
  }, null, 2));
} finally {
  await client.close();
  await server.stop();
}
