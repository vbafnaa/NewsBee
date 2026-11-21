import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { COLLECTIONS } from "../../storage/mongo";
import { newsroomServiceStatus, type ServiceSection } from "../../publications/newsroom-admin-status";

const mocks = vi.hoisted(() => ({ loadNewsroom: vi.fn(), releases: vi.fn(), videos: vi.fn() }));
vi.mock("@/app/newsroom/[publicationId]/newsroom-context", () => ({ loadNewsroom: mocks.loadNewsroom }));
vi.mock("../../../app/newsroom/[publicationId]/newsroom-context", () => ({ loadNewsroom: mocks.loadNewsroom }));

/** Server components nest async components; resolve them first so renderToStaticMarkup can render the tree. */
async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
  if (!isValidElement(node)) return node;
  const { type, props } = node as ReactElement<{ children?: ReactNode }>;
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return resolveServer(await (type as (p: unknown) => Promise<ReactNode>)(props));
  return props.children === undefined ? node : cloneElement(node as ReactElement, undefined, await resolveServer(props.children));
}
const render = async (node: ReactNode) => parseHTML(renderToStaticMarkup(await resolveServer(node) as ReactElement)).document;
vi.mock("@/pipeline/publications/releases", () => ({ listPublicationReleaseStories: mocks.releases }));
vi.mock("@/pipeline/video-production", () => ({ publicationReleaseVideoStates: mocks.videos }));

const room = "north-room";
const base = `/newsroom/${room}`;
const params = Promise.resolve({ publicationId: room });
const card = (sections: ServiceSection[], name: string) => sections.flatMap((section) => section.cards).find((item) => item.name === name)!;

describe("Newsroom admin statuses", () => {
  let server: MongoMemoryServer, client: MongoClient, db: Db;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    db = client.db("newsroom_admin_status");
  }, 60_000);
  beforeEach(async () => {
    await db.dropDatabase();
    for (const key of ["DESKTOP_VIDEO_API_KEY", "FAL_KEY", "NEWSBEE_TAVILY_API_KEY", "NEWSBEE_SERPAPI_API_KEY", "NEWSBEE_READER_SITE_URL"]) vi.stubEnv(key, "");
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { await client?.close(); await server?.stop(); });

  it("says Not checked or Needs attention when nothing is recorded or configured, never Active", async () => {
    const sections = await newsroomServiceStatus(db, {});
    expect(sections.map((section) => section.title)).toEqual(["System", "Storage", "Import & export", "Environment & API"]);
    expect(card(sections, "Collector service")).toMatchObject({ state: "unchecked", detail: "No scheduler run recorded yet", href: "/health" });
    expect(card(sections, "Video renderer")).toMatchObject({ state: "attention", detail: "Desktop Video isn't configured", href: "/health?view=video" });
    expect(card(sections, "Collection API")).toMatchObject({ state: "attention", href: "/account" });
    expect(card(sections, "Video production API").state).toBe("attention");
    expect(card(sections, "Reader application")).toMatchObject({ state: "unchecked", detail: "No reader URL configured" });
    expect(card(sections, "Publishing service")).toMatchObject({ state: "active", detail: "No failed jobs" });
    expect(sections.find((section) => section.id === "transfer")).toMatchObject({ ownerOnly: true });
    for (const section of sections) expect(section.docs ?? "").toMatch(/^(https:\/\/github\.com\/g2minhle\/Newsbee\/blob\/main\/.+\.md)?$/);
  });

  it("reads each card from its record: scheduler, job queue, video failures, maintenance, provider keys and the reader URL", async () => {
    vi.stubEnv("DESKTOP_VIDEO_API_KEY", "fixture-desktop");
    vi.stubEnv("NEWSBEE_TAVILY_API_KEY", "fixture-tavily");
    await db.collection(COLLECTIONS.heartbeat).insertOne({ _id: "scheduler", last_tick_at: Date.now() / 1000 - 5 } as never);
    let sections = await newsroomServiceStatus(db, { NEWSBEE_READER_SITE_URL: "https://reader.example.test/north" });
    expect(card(sections, "Collector service")).toMatchObject({ state: "active", detail: "Scheduler ran just now" });
    expect(card(sections, "Video renderer")).toMatchObject({ state: "active", detail: "Desktop Video configured" });
    expect(card(sections, "Collection API").state).toBe("active");
    expect(card(sections, "Reader application")).toMatchObject({ state: "active", detail: "Reader site at reader.example.test" });
    expect(card(sections, "Archive backups")).toMatchObject({ state: "active", detail: "Site open for writes", href: "/site-backup" });

    await db.collection(COLLECTIONS.heartbeat).updateOne({ _id: "scheduler" } as never, { $set: { last_tick_at: Date.now() / 1000 - 3600 } });
    await db.collection(COLLECTIONS.jobs).insertMany([{ status: "failed" }, { status: "failed" }, { status: "done" }] as never[]);
    await db.collection(COLLECTIONS.videoJobs).insertOne({ status: "failed", created_at: Date.now() } as never);
    await db.collection("_newsbee_restore_state").updateOne({ _id: "site" } as never, { $set: { phase: "restoring" } }, { upsert: true });
    sections = await newsroomServiceStatus(db, {});
    expect(card(sections, "Collector service")).toMatchObject({ state: "attention", detail: "Last scheduler run 1 h ago" });
    expect(card(sections, "Publishing service")).toMatchObject({ state: "attention", detail: "2 failed jobs in the queue" });
    expect(card(sections, "Video renderer")).toMatchObject({ state: "attention", detail: "1 failed video this week" });
    for (const name of ["Archive backups", "Import source map", "Export publication data"]) {
      expect(card(sections, name)).toMatchObject({ state: "attention", detail: "Site restoring" });
    }
  });
});

describe("Videos and New video", () => {
  const release = (id: string, withdrawn = false) => ({ releaseId: id, title: `Edition ${id}`, windowStart: "2026-11-09", windowEnd: "2026-11-15",
    publishedAt: 1_795_000_000, withdrawn, stories: [{ id: "s1", headline: `Story ${id}-1`, locations: ["North"] }, { id: "s2", headline: `Story ${id}-2`, locations: ["North"] }] });
  beforeEach(() => {
    mocks.loadNewsroom.mockResolvedValue({ db: {}, access: { context: {} }, publication: { name: "North newsroom" }, principal: { role: "editor" } });
    mocks.releases.mockResolvedValue([release("r1"), release("r2", true)]);
    mocks.videos.mockResolvedValue(new Map([["r1:s1", { status: "complete", created_at: 1_795_100_000_000 }]]));
  });

  it("lists only story videos that exist, with no way to create one there", async () => {
    const { default: VideosPage } = await import("../../../app/newsroom/[publicationId]/videos/page");
    const { document } = { document: await render(await VideosPage({ params })) };
    const rows = [...document.querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Story r1-1"]);
    expect(rows[0].textContent).toContain("Video ready");
    expect([...rows[0].querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([`${base}/releases/r1`, `${base}/releases/r1/video/s1`]);
    expect(rows[0].textContent).toContain("Release details & email history");
    expect(document.querySelector(".jw-page-tabs, nav[aria-label='Videos views']")).toBeNull();
    expect(document.querySelector(`a[href^="${base}/new-video"], button`)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Campaign|Channel|Create video|Add video/);
  });

  it("says No videos yet and points to New video when there are none", async () => {
    mocks.videos.mockResolvedValue(new Map());
    const { default: VideosPage } = await import("../../../app/newsroom/[publicationId]/videos/page");
    const { document } = { document: await render(await VideosPage({ params })) };
    expect(document.querySelector("table")).toBeNull();
    expect(document.querySelector(".jw-empty")?.textContent).toContain("No videos yet");
    expect([...document.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([`${base}/new-video`]);
  });

  it("creates story videos only: Add a video, pick a published story, then its Video Studio", async () => {
    const { default: NewVideoPage } = await import("../../../app/newsroom/[publicationId]/new-video/page");
    const intro = await render(await NewVideoPage({ params, searchParams: Promise.resolve({}) }));
    expect(intro.querySelector("h1")?.textContent).toBe("Add a video");
    expect(intro.querySelector(".jw-intro .jw-button")?.getAttribute("href")).toBe(`${base}/new-video?step=story`);
    expect([...intro.querySelectorAll(".jw-intro-steps strong")].map((step) => step.textContent))
      .toEqual(["Choose a story", "Write the script and captions", "Generate or upload", "Download"]);
    expect(intro.body.textContent).not.toMatch(/Campaign|platform|analytics/i);

    const picker = await render(await NewVideoPage({ params, searchParams: Promise.resolve({ step: "story" }) }));
    const rows = [...picker.querySelectorAll("tbody tr")];
    // Every story from a live published edition; a withdrawn edition's stories can't get a new video.
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Story r1-1", "Story r1-2"]);
    expect(rows.map((row) => row.querySelector(".jw-link-arrow")?.textContent)).toEqual(["Open", "Choose"]);
    expect(rows.map((row) => row.querySelector(".jw-link-arrow")?.getAttribute("href"))).toEqual([`${base}/releases/r1/video/s1`, `${base}/releases/r1/video/s2`]);
    expect(picker.body.textContent).not.toMatch(/Campaign/);
  });
});
