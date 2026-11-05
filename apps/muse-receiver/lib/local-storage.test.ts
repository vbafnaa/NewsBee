import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { localStorage } from "./local-storage";
import { storage } from "./storage";
import type { Group } from "./validation";
import { postKey, validateReport } from "./validation";

const file = join(process.cwd(), "data", `receiver-test-${randomUUID()}.json`);
const group: Group = { id: randomUUID(), name: "Test group", url: "https://www.facebook.com/groups/12345", createdAt: "2026-10-29T15:00:00.000Z" };
const other: Group = { ...group, id: randomUUID(), url: "https://www.facebook.com/groups/45678" };
afterAll(async () => { await unlink(file).catch(() => {}); });

function input(runTime: string, text: string, publishedAt: string | null = null) {
  const end = new Date(runTime);
  return validateReport({
    runTime, windowStart: new Date(end.getTime() - 3_600_000).toISOString(), windowEnd: runTime, status: "partial",
    scans: [
      { sort: "CHRONOLOGICAL", status: "partial", reason: null, postRefs: ["p1"] },
      { sort: "RECENT_ACTIVITY", status: "partial", reason: null, postRefs: ["p1"] },
    ],
    posts: [{ ref: "p1", id: "post-1", text, permalink: null, sourceLinks: [], publishedAt, rawTime: null,
      observedAt: runTime, commentCount: null, reactions: { total: null, kinds: [], counts: {} },
      contentVerified: true, truncated: false }], issues: [],
  });
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

function report(runTime: string) {
  return { id: `${group.id}:${runTime}`, groupId: group.id, runTime,
    windowStart: new Date(Date.parse(runTime) - 3_600_000).toISOString(), windowEnd: runTime,
    status: "partial", chronologicalStatus: "partial", recentActivityStatus: "partial", issues: [],
    lastHour: [], recentActivityTop10: [postKey(input(runTime, "hello").posts[0])],
    unknownPublicationTime: [], createdAt: runTime };
}

describe("local JSON storage", () => {
  it("selects JSON only in non-production without MongoDB", () => {
    const priorUri = process.env.MONGODB_URI;
    try {
      delete process.env.MONGODB_URI;
      vi.stubEnv("NODE_ENV", "development");
      expect(storage().listGroups).toBeTypeOf("function");
      vi.stubEnv("NODE_ENV", "production");
      expect(() => storage()).toThrow("MONGODB_URI is not configured");
      process.env.MONGODB_URI = "mongodb://localhost:27017";
      expect(storage().listGroups).toBeTypeOf("function");
    } finally {
      vi.unstubAllEnvs();
      if (priorUri === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = priorUri;
    }
  });

  it("persists groups and reports across store instances; updates posts without losing observedAt", async () => {
    const store = localStorage(file);
    await store.createGroup(group);
    await store.createGroup(other);
    await expect(store.createGroup(group)).rejects.toMatchObject({ code: 11000 });
    expect((await localStorage(file).listGroups()).map((item) => item.id)).toContain(group.id);
    expect(await localStorage(file).findGroup(group.id)).toEqual(group);
    const first = input("2026-10-29T16:00:00.000Z", "hello");
    expect(await store.saveReport(group.id, first, report(first.runTime))).toBe(true);
    const next = input("2026-10-29T17:00:00.000Z", "edited", "2026-10-29T16:30:00.000Z");
    expect(await localStorage(file).saveReport(group.id, next, report(next.runTime))).toBe(true);
    expect(await localStorage(file).saveReport(group.id, next, report(next.runTime))).toBe(false);
    const [post] = (await localStorage(file).listPosts(group.id, 0)).posts;
    expect(post).toMatchObject({ text: "edited", observedAt: first.runTime, publishedAt: next.posts[0].publishedAt,
      lastSeenAt: next.runTime, foundIn: ["CHRONOLOGICAL", "RECENT_ACTIVITY"] });
    expect((await localStorage(file).listReports(group.id)).map((r) => r.runTime)).toEqual([next.runTime, first.runTime]);
    expect(await collect(localStorage(file).exportPosts(group.id))).toMatchObject([{ text: "edited" }]);
    expect((await localStorage(file).listPosts(other.id, 0)).posts).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8")).reports).toHaveLength(2);
  });

  it("serializes concurrent independent writes and supports pagination, history limit and export", async () => {
    const store = localStorage(file);
    const reports = Array.from({ length: 61 }, (_, index) => {
      const runTime = new Date(Date.UTC(2026, 9, 30, index)).toISOString();
      const item = input(runTime, `text-${index}`);
      item.posts[0].id = `unique-${index}`;
      return { item, saved: report(runTime) };
    });
    await Promise.all(reports.map(({ item, saved }) => localStorage(file).saveReport(group.id, item, saved)));
    const first = await store.listPosts(group.id, 0);
    expect(first.posts).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect((await store.listPosts(group.id, 1)).posts).toHaveLength(12);
    expect((await store.listPosts(group.id, 1)).hasMore).toBe(false);
    expect(await store.listReports(group.id)).toHaveLength(20);
    expect(await collect(store.exportPosts(group.id))).toHaveLength(62);
    expect(JSON.parse(await readFile(file, "utf8")).posts).toHaveLength(62);
  });
});
