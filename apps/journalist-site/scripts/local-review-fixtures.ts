import { MongoClient, type Db } from "mongodb";
import { defaultRunOptions } from "../pipeline/core/run-options";
import { collectedItems, type CollectedItem } from "../pipeline/editions/assemble";
import { newRun, runs, type PipelineRun } from "../pipeline/orchestration/runs";
import { createOutputChannel, type OutputChannelDocument } from "../pipeline/orchestration/output-channels";
import { resolvePublicationContext } from "../pipeline/publications/access";
import { createPublicationDraftImage, patchPublicationDraft } from "../pipeline/publications/editorial";
import {
  ensurePublicationGenerationIndexes,
  type PublicationDraft,
  type PublicationGeneration,
} from "../pipeline/publications/generation";
import {
  approvePublicationDraft,
  createPublicationCorrection,
  publishPublicationDraft,
} from "../pipeline/publications/releases";
import { publicationPreferenceSnapshot } from "../pipeline/publications/settings";
import { emptyHealth, runSources, sourceMap, type SourceRecord } from "../pipeline/sourcemap/store";
import { LocalArtifacts } from "../pipeline/storage/artifacts";
import { COLLECTIONS } from "../pipeline/storage/mongo";

const principal = { id: "local-admin", email: "owner@newsbee.local", role: "owner" as const };
const window: [string, string] = ["2026-11-09", "2026-11-15"];
const publications = [
  {
    id: "a".repeat(32), name: "Northside Weekly", editor: "local-editor-a",
    location: { id: "northside-wa", name: "Northside, WA" },
    headline: "Library expands weekend programs",
    body: "The neighborhood library is adding new weekend programs for families.",
  },
  {
    id: "b".repeat(32), name: "Harbor Daily", editor: "local-editor-b",
    location: { id: "harbor-wa", name: "Harbor, WA" },
    headline: "Harbor market adds local vendors",
    body: "The waterfront market will welcome more local vendors this weekend.",
  },
];
type FixturePublication = typeof publications[number];

function draft(publication: FixturePublication, index: number, id: string): PublicationDraft {
  const storyId = `local-story-${index + 1}`;
  const createdAt = Date.now() / 1000;
  return {
    _id: id,
    publication_id: publication.id,
    generation_id: `${id}-generation`,
    status: "ready",
    unpublished: true,
    editable: true,
    title: `${publication.name} local edition`,
    window,
    locations: [{ ...publication.location, source_map_version: 1 }],
    stories: [{
      id: storyId,
      canonical_identity: `fixture:${publication.location.id}:notice`,
      location_tags: [publication.location],
      references: [{
        run_id: `local-edition-run-${index + 1}`,
        draft_id: `local-source-edition-${index + 1}`,
        entry_id: `local-entry-${index + 1}`,
        story_id: storyId,
        location_id: publication.location.id,
        collected_item_ids: [`local-evidence-${index + 1}`],
      }],
      snapshot: {
        headline: publication.headline,
        summary: publication.body,
        when_where: publication.location.name,
        event_date: window[1],
        kind: "local_news",
        section: "community",
        sources: [{ name: "Synthetic community notice", url: "https://newsbee.example.test/notice" }],
        image: null,
      },
      review: { status: "ready", flags: [] },
    }],
    versions: {
      publication: "local-review-v1",
      preferences: "local-review-v1",
      config: "local-review-v1",
      source_maps: [{ location_id: publication.location.id, version: 1 }],
    },
    telemetry: { actor: principal, funding: [] },
    revision: 0,
    editorial_status: "editing",
    presentation: {
      headline: `${publication.name} local edition`,
      intro: `Synthetic reporting for ${publication.location.name}.`,
      sections: [{ id: "community", title: "Community" }],
      section_order: ["community"],
      stories: [{
        id: storyId,
        origin: "generated",
        generated_story_id: storyId,
        section_id: "community",
        headline: publication.headline,
        body: publication.body,
        byline: "",
        location_tags: [publication.location.id],
        source_metadata: [{
          id: `${storyId}-source`, type: "web", name: "Synthetic community notice",
          url: "https://newsbee.example.test/notice", note: null,
        }],
        image_id: null,
      }],
      story_order: [storyId],
    },
    updated_at: createdAt,
    updated_by: principal,
    ready_for_approval_at: null,
    ready_for_approval_by: null,
    distribution: { reader: false, email: false },
    created_at: createdAt,
  };
}

function source(publication: FixturePublication, at: number): SourceRecord {
  return {
    _id: `${publication.location.id}:local-notice`,
    location_id: publication.location.id,
    source_id: "local-notice",
    name: `${publication.location.name} synthetic notice`,
    url: "https://newsbee.example.test/notice",
    reader: "web",
    params: {},
    section: "community",
    found_by: { method: "editor", detail: "Isolated review fixture; never fetched." },
    inside_area: true,
    status: "active",
    health: emptyHealth(),
    score: 0,
    first_seen: new Date(at * 1000).toISOString(),
    last_seen: new Date(at * 1000).toISOString(),
  };
}

async function seedReviewFixtures(db: Db, store: LocalArtifacts, readerFolder: string) {
  const marker = db.collection<{ _id: string; completed_at: number; scenario: string }>("local_review_fixtures");
  if (await marker.findOne({ _id: "v1" })) return;
  await ensurePublicationGenerationIndexes(db);
  const at = Date.now() / 1000;
  for (const [index, publication] of publications.entries()) {
    const location = publication.location;
    await db.collection<{ _id: string } & Record<string, unknown>>(COLLECTIONS.locations).replaceOne(
      { _id: location.id },
      {
        _id: location.id, ...location, state: "WA", systems: [], government: null,
        onboarded_at: new Date((at - 86400) * 1000).toISOString(),
        source_map_at: at - 3600, source_map_version: 1,
        source_coverage: { status: "ready", area: location.name, gaps: [], checked_at: new Date(at * 1000).toISOString() },
        preparation: {
          state: "ready", updated_at: new Date(at * 1000).toISOString(),
          updated_by: principal.id, updated_by_email: principal.email, reason: "Synthetic local review coverage.",
        },
      },
      { upsert: true },
    );
    const sourceValue = source(publication, at - 3600);
    await sourceMap(db).replaceOne({ _id: sourceValue._id }, sourceValue, { upsert: true });
    const item: CollectedItem = {
      _id: `local-evidence-${index + 1}`, run_id: `local-edition-run-${index + 1}`,
      location_id: location.id, source_id: sourceValue.source_id, source_name: sourceValue.name,
      title: publication.headline, url: sourceValue.url, event_date: window[1],
      status: "published", reason: null, step: "authoring", story_id: `local-story-${index + 1}`,
      facts: {
        source_event_id: `local-event-${index + 1}`, title: publication.headline,
        event_date: window[1], schedule_text: "Sunday afternoon", venue: location.name,
        source_url: sourceValue.url!, description: publication.body, kind: "local_news",
      },
      created_at: at - 120,
    };
    await collectedItems(db).replaceOne({ _id: item._id }, item, { upsert: true });
    const existing = await db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels).findOne({ _id: publication.id });
    if (!existing) {
      await createOutputChannel(db, principal.id, publication.id, `mongo:${publication.id}`, {
        name: publication.name, enabled: true, destinations: [{ type: "reader", url: "" }],
        selectedLocationIds: [location.id],
      });
    }
    await db.collection<OutputChannelDocument>(COLLECTIONS.outputChannels).updateOne({ _id: publication.id }, {
      $set: { members: [{ principal_id: publication.editor, role: "editor" }] },
    });
    const context = (await resolvePublicationContext<OutputChannelDocument>(db, principal.id, publication.id))!;
    const draftId = `local-draft-${index + 1}`;
    // Replace the previous malformed seed, but leave unrelated local documents alone.
    const value = draft(publication, index, draftId);
    await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).replaceOne({ _id: draftId }, value, { upsert: true });
    async function addMedia(value: PublicationDraft) {
      return (await createPublicationDraftImage(db, context, value._id, value.presentation.stories[0].id, value.revision, {
        image: "https://media.newsbee.example.test/review.svg",
        image_source_url: "https://newsbee.example.test/notice",
        image_credit: "Newsbee synthetic fixture",
        image_caption: "Synthetic review illustration, not a photograph of a real event.",
        image_alt: "Illustrated community notice board",
        image_date: window[1],
        image_license: "Used with permission",
        authority: true, people_permissions: true,
        permission: { editorial: true, archive: true, crop: true },
      }, principal)).draft;
    }
    async function approve(value: PublicationDraft) {
      const ready = await patchPublicationDraft(db, context, value._id, value.revision, { type: "ready_for_approval" }, principal);
      return approvePublicationDraft(db, context, ready._id, ready.revision, principal);
    }
    async function publish(value: PublicationDraft) {
      const approved = await approve(value);
      return publishPublicationDraft(db, store, context, approved._id, approved.approval!.revision, approved.approval!.content_hash, principal);
    }
    const published = await publish(await addMedia(value));
    if (index === 0) {
      const correction = await createPublicationCorrection(db, context, published.release!.release_id,
        "Clarify the synthetic library program location.", principal);
      await patchPublicationDraft(db, context, correction._id, correction.revision, {
        type: "story", storyId: correction.presentation.stories[0].id,
        body: `${publication.body} Programs meet in the community room.`,
      }, principal);
      const updated = (await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).findOne({ _id: correction._id }))!;
      await publish(await addMedia(updated));
    }
    const unpublished = draft(publication, index, `local-unpublished-${index + 1}`);
    await db.collection<PublicationDraft>(COLLECTIONS.publicationDrafts).replaceOne({ _id: unpublished._id }, unpublished, { upsert: true });
    const withMedia = await addMedia(unpublished);
    if (index === 1) await approve(withMedia);
    else await patchPublicationDraft(db, context, withMedia._id, withMedia.revision, {
      type: "add_original_story",
      story: {
        headline: "Neighbors propose a weekend repair cafe",
        body: "Synthetic original reporting for source-control and evidence-panel review.",
        byline: "By Local Editor A",
        sectionId: "community",
        locationTags: [location.id],
        sourceMetadata: [{
          type: "web", name: "Synthetic neighborhood association",
          url: "https://newsbee.example.test/repair-cafe", note: "Synthetic verification context for responsive control review.",
        }],
      },
    }, principal);
  }

  const options = defaultRunOptions({ NODE_ENV: "development", NEWSBEE_RUN_MODE: "manual", NEWSBEE_PAID_ALLOW: "" });
  function run(id: string, publication: FixturePublication, status: PipelineRun["status"], created: number): PipelineRun {
    const value = newRun(publication.location, { by: principal.id, kind: "manual" }, "2026-11-16", window, [], null, ["editor"], options);
    return {
      ...value, _id: id, kind: "map", status, isolated: true,
      created_at: created, updated_at: status === "mapping" ? created : created + 1, stage_started_at: created,
      stage_transitions: [{ status, by: principal.id, at: created }],
      completed_at: status === "mapping" ? null : created + 1,
    };
  }
  const active = run("local-source-run-a", publications[0], "mapping", at);
  active.admission = "newsroom";
  active.execution_blocked = { reason: "Synthetic source run A: no credential sponsor or queued jobs. Review only; cancel rather than claim.", at };
  const historical = run("local-source-run-b", publications[0], "mapped", at - 60);
  const history = Array.from({ length: 205 }, (_, index) =>
    run(`local-history-${String(index).padStart(3, "0")}`, publications[1], "mapped", at - 120 - index * 60));
  const old = run("local-old-run", publications[1], "mapped", at - 86400);
  for (const value of [active, historical, ...history, old]) {
    await runs(db).replaceOne({ _id: value._id }, value, { upsert: true });
  }
  for (const [value, name] of [[active, "Active A notice"], [historical, "Historical B notice"]] as const) {
    const record = { ...source(publications[0], value.created_at), name, agent_run_id: value._id };
    await runSources(db, value._id).replaceOne({ _id: record._id }, record, { upsert: true });
  }
  const context = (await resolvePublicationContext<OutputChannelDocument>(db, principal.id, publications[0].id))!;
  const blockedId = "local-blocked-generation";
  const child = {
    ...run("local-blocked-child", publications[0], "cancelled", at - 30),
    kind: "edition" as const, admission: "publication" as const, isolated: false,
    publication_generation_id: blockedId, publication_id: context.id,
    error: "Synthetic generation stopped: child has no credential sponsor.",
    execution_blocked: { reason: "Synthetic fixture has no credential sponsor.", at: at - 30 },
  };
  await runs(db).replaceOne({ _id: child._id }, child, { upsert: true });
  const blocked: PublicationGeneration = {
    _id: blockedId, admission: "newsroom", publication_id: context.id, publication_name: publications[0].name,
    owner_id: principal.id, initiated_by: principal.id, initiated_by_email: principal.email,
    idempotency_key: blockedId, status: "failed", window, today: "2026-11-16",
    locations: [{ ...publications[0].location, source_map_version: 1 }],
    child_run_ids: [child._id], options, publication_version: "local-review-v1",
    preference_version: "local-review-v1", preference_snapshot: await publicationPreferenceSnapshot(db, context),
    config_version: "local-review-v1", managed_execution: true,
    progress: { total: 1, completed: 0, failed: 1 }, draft_id: null,
    error: child.error, created_at: at - 31, updated_at: at - 29, completed_at: at - 29,
  };
  await db.collection<PublicationGeneration>(COLLECTIONS.publicationGenerations).replaceOne({ _id: blockedId }, blocked, { upsert: true });
  await store.saveJson(readerFolder, "locations.json", { locations: publications.map(({ location }) => location) });
  await marker.insertOne({ _id: "v1", completed_at: Date.now() / 1000, scenario: "source-runs" });
}

async function selectReviewScenario(db: Db, scenario: string) {
  await ensurePublicationGenerationIndexes(db);
  const marker = db.collection<{ _id: string; scenario: string }>("local_review_fixtures");
  const expectedStatus = scenario === "blocked-generation" ? "blocked" : "failed";
  if ((await marker.findOne({ _id: "v1" }))?.scenario === scenario
    && (await db.collection<PublicationGeneration>(COLLECTIONS.publicationGenerations).findOne({ _id: "local-blocked-generation" }))?.status === expectedStatus) return;
  const at = Date.now() / 1000;
  // These two active-workflow snapshots cannot coexist in the global newsroom slot.
  await runs(db).updateOne({ _id: "local-source-run-a" }, { $set: { status: "cancelled", completed_at: at } });
  await db.collection<PublicationGeneration>(COLLECTIONS.publicationGenerations).updateOne({ _id: "local-blocked-generation" }, {
    $set: {
      status: scenario === "blocked-generation" ? "blocked" : "failed",
      error: scenario === "blocked-generation" ? "Synthetic fixture has no credential sponsor. Explicit recovery is required." : "Synthetic generation stopped: child has no credential sponsor.",
      execution_blocked: { reason: "Synthetic fixture has no credential sponsor. Explicit recovery is required.", at },
      updated_at: at,
      completed_at: scenario === "blocked-generation" ? null : at,
      progress: { total: 1, completed: 0, failed: scenario === "blocked-generation" ? 0 : 1 },
    },
  });
  await runs(db).updateOne({ _id: "local-blocked-child" }, {
    $set: {
      status: scenario === "blocked-generation" ? "collecting" : "cancelled",
      error: scenario === "blocked-generation" ? null : "Synthetic generation stopped: child has no credential sponsor.",
      updated_at: at,
      stage_started_at: at,
      stage_transitions: [{ status: scenario === "blocked-generation" ? "collecting" : "cancelled", by: principal.id, at }],
      completed_at: scenario === "blocked-generation" ? null : at,
    },
  });
  if (scenario === "source-runs") {
    await runs(db).updateOne({ _id: "local-source-run-a" }, { $set: { status: "mapping", updated_at: at, completed_at: null } });
  }
  await marker.updateOne({ _id: "v1" }, { $set: { scenario } });
}

const scenario = process.env.NEWSBEE_LOCAL_REVIEW_SCENARIO ?? "source-runs";
if (!["source-runs", "blocked-generation"].includes(scenario)) throw new Error("Unknown NEWSBEE_LOCAL_REVIEW_SCENARIO.");
const uri = process.env.MONGODB_URI;
if (!uri || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(uri).hostname)) {
  throw new Error("Review fixtures require an explicit loopback MongoDB URI; remote databases are not allowed.");
}
const database = process.env.MONGODB_DATABASE;
const drive = process.env.NEWSBEE_LOCAL_DRIVE_DIR;
const readerFolder = process.env.NEWSBEE_READER_DRIVE_FOLDER_ID;
if (!database || !drive || !readerFolder) throw new Error("Review fixture database and local artifact folders must be explicit.");
const client = await MongoClient.connect(uri);
try {
  const db = client.db(database);
  await seedReviewFixtures(db, new LocalArtifacts(drive), readerFolder);
  await selectReviewScenario(db, scenario);
} finally {
  await client.close();
}
