import type { Db } from "mongodb";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../accounts/identity";
import type { PublicationDraft } from "../../publications/generation";
import type { OutputChannelDocument } from "../../orchestration/output-channels";
import { loadPublicationPreview, previewRevision, publicationReaderMetadata, publicationReaderBaseUrl, PublicationReaderConfigurationError } from "../../publications/preview";
import { COLLECTIONS } from "../../storage/mongo";
import { publicationDraftSnapshot } from "../../publications/releases";
import { fetchPublicationPreview } from "../../../../reader-site/src/lib/publication-preview";
import { publicationLinks, publicationPageLinks, publicationPreviewPage } from "../../../../reader-site/src/lib/publication-view";
import { PRIVATE_PREVIEW_HEADERS } from "../../../../../shared/publication-preview";
import { PHOTO_ASSETS } from "../../../../../shared/image-assets";
import type { PublicationDraftImage } from "../../publications/media";
import { planIllustrations } from "../../../../../shared/editorial-illustrations";
import { GET as readerPreviewImage } from "../../../../reader-site/src/pages/api/publications/[publication_id]/drafts/[draft_id]/preview";

const mocks = vi.hoisted(() => ({ principal: vi.fn(), database: vi.fn(), publicLoad: vi.fn() }));
vi.mock("@/lib/admin-session", () => ({ currentPrincipal: mocks.principal }));
vi.mock("@/pipeline/storage/mongo", async (original) => ({
  ...await original<object>(), getDatabase: mocks.database,
}));
vi.mock("../../../../reader-site/src/lib/reader-data", () => ({ loadReaderPublication: mocks.publicLoad }));
import { GET } from "../../../app/api/admin/publications/[publicationId]/drafts/[draftId]/preview/route";

const principal: Principal = { id: "editor", email: "editor@example.test", role: "editor" };
let publication: OutputChannelDocument;
let draft: PublicationDraft;
let db: Db;
let afterImageRead: (() => void) | undefined;
let operations: string[];
let imageRows: PublicationDraftImage[];
const publicationId = "publication-a";
const draftId = "draft-selected";
const context = { params: Promise.resolve({ publicationId, draftId }) };

beforeEach(() => {
  vi.stubEnv("NEWSBEE_READER_MEDIA_MODE", "photos");
  mocks.publicLoad.mockReset();
  publication = {
    _id: publicationId, owner_id: "owner", members: [{ principal_id: principal.id, role: "editor" }],
    name: "Selected Weekly",
  } as OutputChannelDocument;
  draft = {
    _id: draftId, publication_id: publicationId, generation_id: "generation",
    status: "ready", unpublished: true, editable: true, title: "Selected Weekly",
    window: ["2026-11-09", "2026-11-15"],
    locations: [{ id: "north-wa", name: "North, WA", source_map_version: 1 }],
    stories: [], revision: 3, editorial_status: "editing",
    presentation: {
      headline: "Draft headline", intro: "Private introduction",
      sections: [{ id: "community", title: "Community reporting" }], section_order: ["community"],
      stories: [{
        id: "original-story", origin: "original", generated_story_id: null, section_id: "community",
        headline: "Private original headline", body: "Private reporting that has not been published.",
        byline: "Reporter", location_tags: ["north-wa"], image_id: null,
        source_metadata: [{ id: "source", type: "web", name: "Town", url: "https://town.example.test/news", note: null }],
      }],
      story_order: ["original-story"],
    },
    updated_at: 1, updated_by: { id: principal.id, email: principal.email },
    distribution: { reader: false, email: false }, created_at: 1,
  } as PublicationDraft;
  afterImageRead = undefined;
  operations = [];
  imageRows = [];
  db = { collection: (name: string) => {
    if (name === COLLECTIONS.outputChannels) return { findOne: async (filter: any) => {
      operations.push("publication:read");
      const allowed = publication && publication._id === filter._id
        && (!filter.$or || publication.owner_id === principal.id
          || publication.members?.some((member) => member.principal_id === principal.id));
      return allowed ? structuredClone(publication) : null;
    } };
    if (name === COLLECTIONS.publicationDrafts) return { findOne: async (filter: any) => {
      operations.push("draft:read");
      return draft && draft._id === filter._id && draft.publication_id === filter.publication_id ? structuredClone(draft) : null;
    } };
    if (name === COLLECTIONS.publicationImages) return { find: () => ({ toArray: async () => {
      operations.push("images:read");
      afterImageRead?.();
      return structuredClone(imageRows);
    } }) };
    if (name === PHOTO_ASSETS) return { findOne: async (filter: any) => {
      operations.push("asset:read");
      return filter._id === "a".repeat(64) ? { _id: filter._id, variants: [
        { id: "desktop-blob", width: 1200, height: 800, layout: "desktop" },
        { id: "mobile-blob", width: 480, height: 320, layout: "mobile" },
      ] } : null;
    } };
    if (name === `${PHOTO_ASSETS}_blobs`) return { findOne: async () => {
      operations.push("blob:read");
      return { bytes: new Uint8Array([1, 2, 3]), content_type: "image/jpeg", width: 1200, height: 800 };
    } };
    throw new Error(`Unexpected preview collection ${name}`);
  } } as unknown as Db;
  mocks.principal.mockResolvedValue(principal);
  mocks.database.mockResolvedValue(db);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("private exact-revision Reader preview", () => {
  it("uses the release snapshot and real Reader adapter, without publishing metadata or writes", async () => {
    const preview = await loadPublicationPreview(db, principal, publicationId, draftId, 3);
    const snapshot = await publicationDraftSnapshot(db, {
      id: publicationId, ownerId: "owner", principalId: principal.id, role: "editor", publication,
    }, draft);
    expect(preview.snapshot).toEqual(snapshot);
    const page = publicationPreviewPage(preview);
    expect(page.release).toBeNull();
    expect(page.edition.publishedAt).toBeNull();
    expect(page.preview).toMatchObject({ draftId, revision: 3 });
    expect(page.articles[0]).toMatchObject({
      key: "original-story", headline: "Private original headline",
      text: "Private reporting that has not been published.", byline: "Reporter",
    });
    expect(page.allSections[0].label).toBe("Community reporting");
    const links = publicationPageLinks(page);
    for (const href of [links.page, links.publication, links.archive, links.newsletter, links.section("community"),
      links.story("original-story"), links.events("2026-11-10"), links.location("other"), links.contribute("share"), links.browse()]) {
      expect(href).toContain(`/publications/${publicationId}/drafts/${draftId}?revision=3`);
      expect(href).not.toContain("/releases/");
    }
    expect(preview).not.toHaveProperty("published_at");
    expect(preview).not.toHaveProperty("release_id");
    expect(operations.every((operation) => operation.endsWith(":read"))).toBe(true);
    expect(mocks.publicLoad).not.toHaveBeenCalled();
    expect(publicationLinks(publicationId, "released").home).not.toContain("/publications/");
  });

  it.each([
    ["stale", () => { draft.revision = 4; }, 409],
    ["other draft", () => { draft._id = "another-draft"; }, 404],
    ["other publication", () => { draft.publication_id = "another-publication"; }, 404],
    ["published", () => { draft.unpublished = false; }, 409],
    ["publishing", () => { draft.editorial_status = "publishing"; }, 409],
    ["revoked", () => { publication.members = []; }, 404],
  ] as const)("rejects %s without fallback or writes", async (_label, mutate, status) => {
    mutate();
    const response = await GET(new Request("https://newsbee.test/api/preview?revision=3"), context);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(operations.every((operation) => operation.endsWith(":read"))).toBe(true);
    expect(mocks.publicLoad).not.toHaveBeenCalled();
  });

  it.each(["revision", "access", "settings"] as const)("rechecks current %s after snapshot/media loading", async (change) => {
    afterImageRead = () => {
      if (change === "revision") draft.revision++;
      if (change === "access") publication.members = [];
      if (change === "settings") publication.name = "Changed name";
    };
    const response = await GET(new Request("https://newsbee.test/api/preview?revision=3"), context);
    expect(response.status).toBe(change === "access" ? 404 : 409);
  });

  it("requires authentication and an explicit unambiguous exact revision", async () => {
    mocks.principal.mockResolvedValue(null);
    expect((await GET(new Request("https://newsbee.test/api/preview?revision=3"), context)).status).toBe(401);
    expect(operations).toEqual([]);
    for (const value of [null, "", "-1", "03", "3.1", "Infinity", "9007199254740992"]) {
      expect(() => previewRevision(value)).toThrow();
    }
    expect(previewRevision("0")).toBe(0);
  });

  it("keeps correction photos on an authenticated exact-draft media route and rechecks access for bytes", async () => {
    draft.correction = { supersedes_release_id: "old-release", reason: "Corrected reporting." };
    draft.presentation.stories[0].image_id = "private-image";
    imageRows = [{
      _id: "private-image", publication_id: publicationId, draft_id: draftId, story_id: "original-story",
      image: {
        image: "https://images.example.test/original.jpg", image_credit: "Local photographer",
        image_source_url: "https://images.example.test/source", image_asset_id: "a".repeat(64),
      },
      permission: { editorial: true, archive: true, crop: true },
      authority_confirmed: true, people_permissions_confirmed: true,
      created_at: 1, updated_at: 1, created_by: { id: principal.id, email: principal.email },
      removed_at: null, removed_by: null,
    }];
    const preview = await loadPublicationPreview(db, principal, publicationId, draftId, 3);
    const page = publicationPreviewPage(preview);
    expect(page.preview?.correction?.reason).toBe("Corrected reporting.");
    expect(page.edition.corrections).toEqual([]);
    expect(page.articles[0].photo?.src).toContain("/api/publications/publication-a/drafts/draft-selected/preview?revision=3&image=original-story");
    const imageRequest = new Request("https://newsbee.test/api/preview?revision=3&image=original-story&width=480&layout=mobile");
    const response = await GET(imageRequest, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    publication.members = [];
    expect((await GET(imageRequest, context)).status).toBe(404);
    expect(operations.every((operation) => operation.endsWith(":read"))).toBe(true);
  });

  it("rejects conflicting revision parameters before loading any draft", async () => {
    const response = await GET(new Request("https://newsbee.test/api/preview?revision=3&revision=4"), context);
    expect(response.status).toBe(422);
    expect(operations).toEqual([]);
  });

  it("returns an exact-revision browser URL with the configured Reader origin or same-host default", async () => {
    const request = new Request("https://newsbee.test/api/preview?revision=3");
    const suffix = "/reader/publications/publication-a/drafts/draft-selected?revision=3";
    for (const [configured, expected] of [
      [undefined, suffix],
      ["", suffix],
      ["   ", suffix],
      ["https://reader.example.test/reader/", `https://reader.example.test${suffix}`],
      ["https://reader.example.test", `https://reader.example.test${suffix}`],
      ["https://newsbee-seven.vercel.app/reader", `https://newsbee-seven.vercel.app${suffix}`],
      ["http://127.0.0.1:4332/reader", `http://127.0.0.1:4332${suffix}`],
    ]) {
      vi.stubEnv("NEWSBEE_MODE", "local");
      vi.stubEnv("NEWSBEE_READER_SITE_URL", configured);
      const response = await GET(request, context);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        kind: "publication-draft-preview", preview_url: expected,
        snapshot: { draft_id: draftId, draft_revision: 3 },
      });
    }
    vi.stubEnv("NEWSBEE_MODE", "cloud");
    vi.stubEnv("NEWSBEE_READER_SITE_URL", "https://newsbee-seven.vercel.app/reader");
    expect(publicationReaderBaseUrl()).toBe("https://newsbee-seven.vercel.app/reader");
  });

  it.each([
    ["not a URL", "absolute URL"],
    ['"https://placeholder.invalid/reader"', "absolute URL"],
    ["/reader", "absolute URL"],
    ["reader.example.test/reader", "absolute URL"],
    ["https://user:password@reader.example.test/reader", "username or password"],
    ["https://reader.example.test/reader?secret=fixture", "query string or fragment"],
    ["https://reader.example.test/reader#fragment", "query string or fragment"],
    ["http://reader.example.test/reader", "requires HTTPS"],
    ["http://127.0.0.1:4332/reader", "requires HTTPS"],
  ])("exposes safe actionable diagnostics and fails strict preview privately for %s", async (configured, reason) => {
    vi.stubEnv("NEWSBEE_MODE", "cloud");
    vi.stubEnv("NEWSBEE_READER_SITE_URL", configured);
    expect(() => publicationReaderBaseUrl()).toThrow(PublicationReaderConfigurationError);
    const metadata = publicationReaderMetadata();
    expect(metadata).toMatchObject({ readerBaseUrl: null, readerLink: { state: "unavailable" } });
    expect(metadata.readerLink).toMatchObject({ detail: expect.stringContaining(reason) });
    expect(metadata.readerLink).toMatchObject({ detail: expect.stringContaining("Newsroom profile and destination settings cannot repair") });
    expect(JSON.stringify(metadata)).not.toMatch(/user:password|secret=fixture|reader\.example\.test|placeholder\.invalid/);
    const response = await GET(new Request("https://newsbee.test/api/preview?revision=3"), context);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe(PRIVATE_PREVIEW_HEADERS["X-Robots-Tag"]);
    expect(await response.json()).toEqual({ detail: metadata.readerLink.state === "unavailable" ? metadata.readerLink.detail : "" });
    expect(operations).toContain("draft:read");
    expect(mocks.publicLoad).not.toHaveBeenCalled();
    draft.revision++;
    expect((await GET(new Request("https://newsbee.test/api/preview?revision=3"), context)).status).toBe(409);
  });

  it("does not extend the local HTTP exception to remote or lookalike hosts", () => {
    vi.stubEnv("NEWSBEE_MODE", "local");
    for (const host of ["reader.example.test", "localhost.example.test", "127.0.0.1.example.test"]) {
      vi.stubEnv("NEWSBEE_READER_SITE_URL", `http://${host}:4332/reader`);
      expect(() => publicationReaderBaseUrl()).toThrow("requires HTTPS");
    }
  });

  it("preserves frozen generated illustrations in the shared Reader adapter", async () => {
    vi.stubEnv("NEWSBEE_READER_MEDIA_MODE", "illustrated");
    const preview = await loadPublicationPreview(db, principal, publicationId, draftId, 3);
    const art = planIllustrations([{ headline: "Library reading room", kind: "local_news" }], "north-wa").get(0)!;
    Object.assign(preview.snapshot.items[0], {
      origin: "generated", illustration_id: art.id, illustration_asset_id: art.asset_id ?? art.id,
      illustration_policy: art.policy, image_alt: art.alt,
    });
    const page = publicationPreviewPage(preview);
    expect(page.articles[0].illustration).toMatchObject(art);
    expect(page.topStories[0].illustration).toEqual(page.articles[0].illustration);
    expect(page.articles[0].photo).toBeUndefined();
  });

  it("streams only private authenticated bound media, never JSON or public fallback responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetcher);
    const url = new URL("https://newsbee.test/reader/api/preview?revision=3&image=original-story&width=480&layout=mobile");
    const args = {
      request: new Request(url, { headers: { cookie: "authjs.session-token=signed" } }),
      url, params: { publication_id: publicationId, draft_id: draftId },
    } as Parameters<typeof readerPreviewImage>[0];
    const response = await readerPreviewImage(args);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetcher.mock.calls[0][0].href).toBe("https://newsbee.test/api/admin/publications/publication-a/drafts/draft-selected/preview?revision=3&image=original-story&width=480&layout=mobile");
    fetcher.mockResolvedValue(Response.json({ detail: "No access" }, { status: 403 }));
    expect((await readerPreviewImage(args)).status).toBe(403);
    fetcher.mockResolvedValue(Response.json({ published: "not-an-image" }));
    expect((await readerPreviewImage(args)).status).toBe(503);
  });

  it("uses the existing same-host local AUTH_URL port only in local development", async () => {
    vi.stubEnv("NEWSBEE_MODE", "local");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000");
    const payload = await loadPublicationPreview(db, principal, publicationId, draftId, 3);
    const fetcher = vi.fn().mockImplementation(async () => Response.json(payload));
    const request = new Request("http://127.0.0.1:4321/reader/preview?revision=3");
    await fetchPublicationPreview(request, publicationId, draftId, "3", fetcher);
    expect(fetcher.mock.calls.at(-1)?.[0].origin).toBe("http://127.0.0.1:3000");
    vi.stubEnv("AUTH_URL", "https://unrelated.test");
    await fetchPublicationPreview(request, publicationId, draftId, "3", fetcher);
    expect(fetcher.mock.calls.at(-1)?.[0].origin).toBe("http://127.0.0.1:4321");
    vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000");
    vi.stubEnv("NODE_ENV", "production");
    await fetchPublicationPreview(request, publicationId, draftId, "3", fetcher);
    expect(fetcher.mock.calls.at(-1)?.[0].origin).toBe("http://127.0.0.1:4321");
  });

  it("passes only the session cookie to the fixed same-host bridge, and validates response binding", async () => {
    const payload = await loadPublicationPreview(db, principal, publicationId, draftId, 3);
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload));
    const request = new Request("https://newsbee.test/reader/preview?revision=3", {
      headers: { cookie: "authjs.session-token=signed", authorization: "do-not-forward", "x-forwarded-host": "evil.test" },
    });
    expect(await fetchPublicationPreview(request, publicationId, draftId, "3", fetcher)).toEqual(payload);
    expect(fetcher.mock.calls[0][0].href).toBe("https://newsbee.test/api/admin/publications/publication-a/drafts/draft-selected/preview?revision=3");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { cookie: "authjs.session-token=signed", accept: "application/json" }, cache: "no-store", redirect: "error",
    });
    payload.snapshot.draft_revision = 4;
    fetcher.mockResolvedValue(Response.json(payload));
    await expect(fetchPublicationPreview(request, publicationId, draftId, "3", fetcher)).rejects.toMatchObject({ status: 409 });
    fetcher.mockResolvedValue(Response.json({}, { status: 401 }));
    await expect(fetchPublicationPreview(request, publicationId, draftId, "3", fetcher)).rejects.toMatchObject({ status: 401 });
    expect(PRIVATE_PREVIEW_HEADERS).toMatchObject({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
  });
});
