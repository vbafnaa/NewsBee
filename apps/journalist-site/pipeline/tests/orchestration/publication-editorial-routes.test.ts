import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Principal } from "../../accounts/identity";
import { createOutputChannel } from "../../orchestration/output-channels";
import type { PublicationDraft } from "../../publications/generation";
import { COLLECTIONS } from "../../storage/mongo";
import { loadSettings } from "../../core/config";
import { recoverStartingPublicationGenerations } from "../../publications/generation";
import { enterPublicationSupport, type PublicationSupport } from "../../publications/support";
import { GET as getGenerations } from "../../../app/api/admin/publications/[publicationId]/generations/route";
import { GET as getDraft, PATCH as patchDraft } from "../../../app/api/admin/publications/[publicationId]/drafts/[draftId]/route";
import { POST as addImage } from "../../../app/api/admin/publications/[publicationId]/drafts/[draftId]/images/route";
import { GET as getNotes, POST as addNote } from "../../../app/api/admin/publications/[publicationId]/drafts/[draftId]/notes/route";

const state = vi.hoisted(() => ({
  db: null as Db | null,
  principal: {
    id: "route-owner",
    email: "route-owner@example.test",
    role: "owner" as const,
  } as Principal,
}));
const principal: Principal = state.principal;
vi.mock("@/pipeline/publications/generation", async (original) => ({
  ...await original<typeof import("../../publications/generation")>(),
  recoverStartingPublicationGenerations: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/admin-api", () => ({
  adminRoute: async (_request: Request, handler: (deps: unknown) => Promise<unknown>) => {
    try {
      const result = await handler({ db: state.db!, principal: state.principal, settings: loadSettings({ NEWSBEE_MODE: "local" }) });
      return result instanceof Response ? result : Response.json(result);
    } catch (error) {
      const name = error instanceof Error ? error.constructor.name : "";
      const status = name === "PublicationAccessDenied" ? 403 : name === "PublicationDraftConflict" ? 409
        : name === "PublicationDraftValidationError" ? 422
          : 500;
      return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status });
    }
  },
  publicationRoute: async (_request: Request, handler: (deps: unknown) => Promise<unknown>) => {
    try {
      const result = await handler({ db: state.db!, principal: state.principal, settings: loadSettings({ NEWSBEE_MODE: "local" }) });
      return result instanceof Response ? result : Response.json(result);
    } catch (error) {
      const name = error instanceof Error ? error.constructor.name : "";
      const status = name === "PublicationAccessDenied" ? 403 : name === "PublicationDraftConflict" ? 409
        : name === "PublicationDraftValidationError" ? 422
          : 500;
      return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status });
    }
  },
  jsonBody: (request: Request) => request.json(),
  kickPipeline: vi.fn(() => { throw new Error("Workspace fixture must not dispatch provider work."); }),
}));

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
const publicationId = "c".repeat(32);
const draftId = "route-draft";
const storyId = "route-story";
const context = { params: Promise.resolve({ publicationId, draftId }) };
const baseUrl = `https://fixture.example.test/api/admin/publications/${publicationId}/drafts/${draftId}`;

function draft(): PublicationDraft {
  return {
    _id: draftId,
    publication_id: publicationId,
    generation_id: "route-generation",
    status: "ready",
    unpublished: true,
    editable: true,
    title: "Route Weekly",
    window: ["2026-11-09", "2026-11-15"],
    locations: [{ id: "town-wa", name: "Town, WA", source_map_version: 1 }],
    stories: [{
      id: storyId,
      canonical_identity: "story:route",
      location_tags: [{ id: "town-wa", name: "Town, WA" }],
      references: [],
      snapshot: {
        headline: "Route story",
        summary: "Route story body.",
        when_where: null,
        event_date: null,
        kind: "news",
        section: "news",
        sources: [{ name: "Fixture", url: "https://fixture.example.test/story" }],
        image: null,
      },
      review: { status: "ready", flags: [] },
    }],
    versions: {
      publication: "one",
      preferences: "two",
      config: "three",
      source_maps: [{ location_id: "town-wa", version: 1 }],
    },
    telemetry: { actor: { id: principal.id, email: principal.email }, funding: [] },
    revision: 0,
    editorial_status: "editing",
    presentation: {
      headline: "Route Weekly",
      intro: "",
      sections: [{ id: "news", title: "News" }],
      section_order: ["news"],
      stories: [{
        id: storyId,
        origin: "generated",
        generated_story_id: storyId,
        section_id: "news",
        headline: "Route story",
        body: "Route story body.",
        byline: "",
        location_tags: ["town-wa"],
        source_metadata: [{ id: "source", type: "web", name: "Fixture", url: "https://fixture.example.test/story", note: null }],
        image_id: null,
      }],
      story_order: [storyId],
    },
    updated_at: 1,
    updated_by: { id: principal.id, email: principal.email },
    ready_for_approval_at: null,
    ready_for_approval_by: null,
    distribution: { reader: false, email: false },
    created_at: 1,
  };
}

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("publication-editorial-routes");
});

beforeEach(async () => {
  vi.stubEnv("NEWSBEE_READER_SITE_URL", "");
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  await db.dropDatabase();
  state.db = db;
  state.principal = principal;
  await createOutputChannel(db, principal.id, publicationId, "route-folder", {
    name: "Route Weekly",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: ["town-wa"],
  });
  await db.collection(COLLECTIONS.publicationDrafts).insertOne(draft());
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

it.each([
  [undefined, "/reader"], ["", "/reader"], [" \t ", "/reader"],
  ["https://reader.example.test", "https://reader.example.test/reader"],
  ["https://reader.example.test/reader/", "https://reader.example.test/reader"],
  ["not a URL", null], ['"https://placeholder.invalid/reader"', null],
  ["https://user:password@reader.example.test", null],
  ["https://reader.example.test?secret=fixture", null],
  ["https://reader.example.test#fragment", null],
  ["http://reader.example.test/reader", null], ["http://127.0.0.1:4332/reader", null],
])("retains both workspace GET contracts for Reader configuration %s", async (configured, expected) => {
  vi.stubEnv("NEWSBEE_READER_SITE_URL", configured);
  for (const response of [
    await getDraft(new Request(baseUrl), context),
    await getGenerations(new Request(`https://fixture.test/generations?draft=${draftId}&generation=route-generation`), context),
  ]) {
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      draft: { _id: draftId, generation_id: "route-generation", revision: 0 },
      readerBaseUrl: expected, readerLink: { state: expected === null ? "unavailable" : "available" },
    });
    if (expected === null) {
      expect(result.readerLink.detail).toContain("configuration");
      expect(JSON.stringify(result)).not.toContain(configured);
    }
    if (result.publication) {
      expect(result.publication).toMatchObject({ role: "owner", canWrite: true });
      expect(result.drafts.map((item: { _id: string }) => item._id)).toContain(draftId);
      expect(result.locations).toEqual([]);
    }
  }
});

it("keeps local loopback available in both metadata routes", async () => {
  vi.stubEnv("NEWSBEE_MODE", "local");
  vi.stubEnv("NEWSBEE_READER_SITE_URL", "http://localhost:4332/reader/");
  for (const response of [
    await getDraft(new Request(baseUrl), context),
    await getGenerations(new Request("https://fixture.test/generations"), context),
  ]) {
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      readerBaseUrl: "http://localhost:4332/reader", readerLink: { state: "available" },
    });
  }
});

it("does not mask unrelated workspace failures as optional Reader configuration", async () => {
  vi.stubEnv("NEWSBEE_READER_SITE_URL", "not a URL");
  vi.mocked(recoverStartingPublicationGenerations).mockRejectedValueOnce(new Error("Fixture recovery failed"));
  const generations = await getGenerations(new Request("https://fixture.test/generations"), context);
  expect(generations.status).toBe(500);
  expect(await generations.json()).toEqual({ detail: "Fixture recovery failed" });
  vi.spyOn(db, "collection").mockImplementationOnce(() => { throw new Error("Fixture database failed"); });
  const selected = await getDraft(new Request(baseUrl), context);
  expect(selected.status).toBe(500);
  expect(await selected.json()).toEqual({ detail: "Fixture database failed" });
});

it.each(["editor", "admin"] as const)("preserves assigned %s access, writes and inspection restrictions with unavailable links", async (role) => {
  vi.stubEnv("NEWSBEE_READER_SITE_URL", "not a URL");
  await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
    $set: { members: [{ principal_id: "assigned-writer", role: "editor" }] },
  });
  state.principal = { id: "assigned-writer", email: "assigned@example.test", role };
  const assigned = await getGenerations(new Request("https://fixture.test/generations"), context);
  expect(assigned.status).toBe(200);
  expect(await assigned.json()).toMatchObject({ publication: { canWrite: true }, readerBaseUrl: null });
  const saved = await patchDraft(new Request(baseUrl, {
    method: "PATCH", body: JSON.stringify({ expectedRevision: 0, operation: { type: "draft", headline: "Permitted edit" } }),
  }), context);
  expect(saved.status).toBe(200);
  expect(await (await getDraft(new Request(baseUrl), context)).json()).toMatchObject({
    draft: { revision: 1, presentation: { headline: "Permitted edit" } }, readerBaseUrl: null,
  });
  state.principal = { ...state.principal, id: "unassigned" };
  await db.collection("journalist_admins").insertOne({
    principalId: state.principal.id, email: state.principal.email, role, enabled: true,
  });
  const inspected = await getGenerations(new Request("https://fixture.test/generations"), context);
  expect(inspected.status).toBe(role === "editor" ? 404 : 200);
  if (role === "admin") {
    expect(await inspected.json()).toMatchObject({ publication: { role: "privileged", canWrite: false } });
    expect((await patchDraft(new Request(baseUrl, {
      method: "PATCH", body: JSON.stringify({ expectedRevision: 1, operation: { type: "draft", headline: "Forbidden" } }),
    }), context)).status).toBe(403);
    const support = await enterPublicationSupport(db, state.principal, publicationId, "Investigate Reader configuration warning");
    const supported = await getGenerations(new Request("https://fixture.test/generations"), context);
    expect(await supported.json()).toMatchObject({ publication: { canWrite: true, supportExpiresAt: support.expires_at } });
    await db.collection<PublicationSupport>("publication_support_sessions").updateOne({ _id: support._id }, {
      $set: { expires_at: Date.now() - 1 },
    });
    const expired = await getGenerations(new Request("https://fixture.test/generations"), context);
    expect(await expired.json()).toMatchObject({ publication: { canWrite: false, supportExpiresAt: null }, readerBaseUrl: null });
    expect((await getDraft(new Request(baseUrl), context)).status).toBe(200);
    expect((await patchDraft(new Request(baseUrl, {
      method: "PATCH", body: JSON.stringify({ expectedRevision: 1, operation: { type: "draft", headline: "Expired" } }),
    }), context)).status).toBe(403);
  }
});

it("returns the scoped workspace, patches with 409 conflicts, and keeps notes on a separate route", async () => {
  const initial = await getDraft(new Request(baseUrl), context);
  expect(initial.status).toBe(200);
  expect(JSON.stringify(await initial.json())).not.toContain("private interview");

  const saved = await patchDraft(new Request(baseUrl, {
    method: "PATCH",
    body: JSON.stringify({
      expectedRevision: 0,
      operation: { type: "draft", headline: "Edited route headline", intro: "Edited route introduction." },
    }),
  }), context);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    draft: { revision: 1, presentation: { headline: "Edited route headline" } },
  });
  const stale = await patchDraft(new Request(baseUrl, {
    method: "PATCH",
    body: JSON.stringify({
      expectedRevision: 0,
      operation: { type: "draft", headline: "Stale route headline" },
    }),
  }), context);
  expect(stale.status).toBe(409);

  const noteResponse = await addNote(new Request(`${baseUrl}/notes`, {
    method: "POST",
    body: JSON.stringify({
      storyId,
      expectedDraftRevision: 1,
      note: { interviewee: "Route source", interviewedAt: "2026-11-11", body: "private interview detail" },
    }),
  }), context);
  expect(noteResponse.status).toBe(200);
  expect(await noteResponse.clone().json()).toMatchObject({ draft: { revision: 2 } });
  const workspace = await (await getDraft(new Request(baseUrl), context)).json();
  expect(JSON.stringify(workspace)).not.toContain("private interview detail");
  const noteList = await (await getNotes(new Request(`${baseUrl}/notes?storyId=${storyId}`), context)).json();
  expect(noteList.notes).toMatchObject([{ body: "private interview detail" }]);

  state.principal = {
    id: "privileged-inspector",
    email: "inspector@example.test",
    role: "admin",
  };
  const inspected = await getNotes(new Request(
    `${baseUrl}/notes?storyId=${storyId}&reason=${encodeURIComponent("Investigate a reported private-note access problem")}`,
  ), context);
  expect(inspected.status).toBe(200);
  expect(await inspected.json()).toMatchObject({ notes: [{ body: "private interview detail" }] });
  expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({
    publication_id: publicationId,
    principal_id: "privileged-inspector",
    action: "privileged_inspection",
  })).toBe(1);
});

it("keeps an editor inside assigned publications", async () => {
  await db.collection(COLLECTIONS.outputChannels).updateOne(
    { _id: publicationId },
    { $set: { members: [{ principal_id: "assigned-editor", role: "editor" }] } },
  );
  state.principal = {
    id: "assigned-editor",
    email: "assigned@example.test",
    role: "editor",
  };
  expect((await getDraft(new Request(baseUrl), context)).status).toBe(200);
  state.principal = {
    id: "other-editor",
    email: "other@example.test",
    role: "editor",
  };
  expect((await getDraft(new Request(baseUrl), context)).status).toBe(404);
});

it("attaches a rights-confirmed image and rejects incomplete rights metadata", async () => {
  const invalid = await addImage(new Request(`${baseUrl}/images`, {
    method: "POST",
    body: JSON.stringify({
      storyId,
      expectedRevision: 0,
      image: {
        image: "https://images.example.test/photo.jpg",
        image_source_url: "https://images.example.test/source",
        image_credit: "Fixture photographer",
        image_caption: "A fixture photograph.",
        image_alt: "A fixture photograph.",
        image_date: "2026-11-11",
        authority: false,
        people_permissions: true,
        permission: { editorial: true, archive: true, crop: true },
      },
    }),
  }), context);
  expect(invalid.status).toBe(422);

  const missingAlt = await addImage(new Request(`${baseUrl}/images`, {
    method: "POST",
    body: JSON.stringify({
      storyId,
      expectedRevision: 0,
      image: {
        image: "https://images.example.test/photo.jpg",
        image_source_url: "https://images.example.test/source",
        image_credit: "Fixture photographer",
        image_caption: "A fixture photograph.",
        image_date: "2026-11-11",
        authority: true,
        people_permissions: true,
        permission: { editorial: true, archive: true, crop: true },
      },
    }),
  }), context);
  expect(missingAlt.status).toBe(422);

  const attached = await addImage(new Request(`${baseUrl}/images`, {
    method: "POST",
    body: JSON.stringify({
      storyId,
      expectedRevision: 0,
      image: {
        image: "https://images.example.test/photo.jpg",
        image_source_url: "https://images.example.test/source",
        image_credit: "Fixture photographer",
        image_caption: "A fixture photograph.",
        image_alt: "A fixture photograph.",
        image_date: "2026-11-11",
        image_license: "Used with permission",
        authority: true,
        people_permissions: true,
        permission: { editorial: true, archive: true, crop: true },
      },
    }),
  }), context);
  expect(attached.status).toBe(200);
  expect(await attached.json()).toMatchObject({
    draft: { revision: 1, presentation: { stories: [{ image_id: expect.any(String) }] } },
    image: { permission: { editorial: true, archive: true, crop: true } },
  });
});
