import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { localStorage } from "./local-storage";

const file = join(process.cwd(), "data", `routes-test-${randomUUID()}.json`);
vi.mock("@/lib/storage", () => ({ storage: () => localStorage(file) }));

import { GET as listGroups, POST as createGroup } from "../app/api/groups/route";
import { GET as detail } from "../app/api/groups/[groupId]/route";
import { GET as prompt } from "../app/api/groups/[groupId]/prompt/route";
import { POST as ingest } from "../app/api/groups/[groupId]/reports/route";
import { GET as posts } from "../app/api/groups/[groupId]/posts/route";
import { GET as exportPosts } from "../app/api/groups/[groupId]/export/route";

afterAll(async () => { await unlink(file).catch(() => {}); });
const request = (body: unknown) => new Request("http://localhost/api/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("group APIs backed by local JSON", () => {
  it("persists creation, validated ingestion and dedup, detail, history, pagination and export", async () => {
    const groupResponse = await createGroup(request({ name: "Community", url: "https://facebook.com/groups/12345" }));
    expect(groupResponse.status).toBe(201);
    const { group } = await groupResponse.json();
    const context = { params: Promise.resolve({ groupId: group.id as string }) };
    expect((await (await listGroups()).json()).groups).toHaveLength(1);
    expect((await (await detail(new Request("http://localhost"), context)).json()).group).toEqual(group);
    expect((await (await prompt(new Request("http://localhost"), context)).json()).reportUrl).toContain(group.id);
    const report = {
      runTime: "2026-10-29T16:00:00.000Z", windowStart: "2026-10-29T15:00:00.000Z", windowEnd: "2026-10-29T16:00:00.000Z", status: "partial",
      scans: [
        { sort: "CHRONOLOGICAL", status: "partial", postRefs: ["a", "b"] },
        { sort: "RECENT_ACTIVITY", status: "partial", postRefs: ["b", "a"] },
      ],
      posts: [
        { ref: "a", id: "a", text: "Timed post", permalink: null, sourceLinks: [], publishedAt: "2026-10-29T15:30:00.000Z", rawTime: null, observedAt: "2026-10-29T16:00:00.000Z", commentCount: 2, reactions: { total: 3, kinds: ["like"], counts: { like: 3 } }, contentVerified: true, truncated: false },
        { ref: "b", id: "b", text: "Unknown time", permalink: null, sourceLinks: [], publishedAt: null, rawTime: "recently", observedAt: "2026-10-29T16:00:00.000Z", commentCount: null, reactions: { total: null, kinds: [], counts: {} }, contentVerified: true, truncated: false },
      ], issues: [],
    };
    const url = `http://localhost/api/groups/${group.id}/reports`;
    expect((await ingest(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...report, scans: [report.scans[0]] }) }), context)).status).toBe(400);
    const first = await ingest(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) }), context);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ accepted: 2, lastHour: 1, recentActivityTop10: 2, unknownPublicationTime: 1 });
    expect((await ingest(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) }), context)).status).toBe(200);
    const page = await (await posts(new Request(`http://localhost/api/groups/${group.id}/posts?page=0`), context)).json();
    expect(page).toMatchObject({ page: 0, hasMore: false });
    expect(page.posts).toHaveLength(2);
    expect(page.reports).toHaveLength(1);
    expect(page.reports[0].lastHour).toHaveLength(1);
    expect(page.reports[0].unknownPublicationTime).toHaveLength(1);
    expect((await (await posts(new Request(`http://localhost/api/groups/${group.id}/posts?page=1`), context)).json()).posts).toEqual([]);
    const exported = await (await exportPosts(new Request("http://localhost"), context)).json();
    expect(exported.posts).toHaveLength(2);
    expect(exported.posts[0]).not.toHaveProperty("groupId");
    expect(JSON.parse(await readFile(file, "utf8")).reports).toHaveLength(1);
  });
});
