import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StoredPost, StoredReport } from "./db";
import type { Storage } from "./storage";
import type { Group } from "./validation";
import { postKey } from "./validation";

type Data = { groups: Group[]; posts: StoredPost[]; reports: StoredReport[] };
const empty = (): Data => ({ groups: [], posts: [], reports: [] });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export function localStorage(file = join(process.cwd(), "data", "muse-receiver.json")): Storage {
  async function read(): Promise<Data> {
    try { return JSON.parse(await readFile(file, "utf8")) as Data; }
    catch (error) { if (missing(error)) return empty(); throw error; }
  }

  async function write(data: Data) {
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data));
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temp);
      throw error;
    }
    await handle.close();
    try { await rename(temp, file); }
    catch (error) { await unlink(temp); throw error; }
  }

  async function mutate<T>(update: (data: Data) => T): Promise<T> {
    await mkdir(dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    const deadline = Date.now() + 10_000;
    let handle;
    while (!handle) {
      try { handle = await open(lock, "wx", 0o600); }
      catch (error) {
        if (!["EEXIST", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        if (Date.now() >= deadline) throw new Error("Local data file is locked; if no writer is running, remove the .lock file");
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
      }
    }
    try {
      const data = await read();
      const result = update(data);
      await write(data);
      return result;
    } finally {
      try { await handle.close(); }
      finally { await unlink(lock); }
    }
  }

  return {
    async listGroups() { return (await read()).groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200); },
    async createGroup(group) {
      await mutate((data) => {
        if (data.groups.some((existing) => existing.url === group.url)) {
          throw Object.assign(new Error("Duplicate group"), { code: 11000 });
        }
        data.groups.push(group);
      });
    },
    async findGroup(id) { return (await read()).groups.find((group) => group.id === id) ?? null; },
    async saveReport(groupId, input, report) {
      return mutate((data) => {
        for (const post of input.posts) {
          const key = postKey(post);
          const foundIn = input.scans.filter((scan) => scan.postRefs.includes(post.ref)).map((scan) => scan.sort);
          const existing = data.posts.find((item) => item.groupId === groupId && item.key === key);
          if (existing) {
            Object.assign(existing, {
              id: post.id, text: post.text, permalink: post.permalink, sourceLinks: post.sourceLinks,
              rawTime: post.rawTime, commentCount: post.commentCount, reactions: post.reactions,
              contentVerified: post.contentVerified, truncated: post.truncated, lastSeenAt: input.runTime,
              ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
              foundIn: [...new Set([...existing.foundIn, ...foundIn])],
            });
          } else {
            data.posts.push({ groupId, key, id: post.id, text: post.text, permalink: post.permalink,
              sourceLinks: post.sourceLinks, ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
              rawTime: post.rawTime, observedAt: post.observedAt, commentCount: post.commentCount,
              reactions: post.reactions, contentVerified: post.contentVerified, truncated: post.truncated,
              lastSeenAt: input.runTime, foundIn });
          }
        }
        const index = data.reports.findIndex((item) => item.groupId === groupId && item.runTime === input.runTime);
        if (index < 0) data.reports.push(report);
        else data.reports[index] = report;
        return index < 0;
      });
    },
    async listPosts(groupId, page) {
      const posts = (await read()).posts.filter((post) => post.groupId === groupId)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(page * 50, page * 50 + 51)
        .map(({ groupId: _groupId, ...post }) => post as StoredPost);
      return { posts: posts.slice(0, 50), hasMore: posts.length > 50 };
    },
    async listReports(groupId) {
      return (await read()).reports.filter((report) => report.groupId === groupId)
        .sort((a, b) => b.runTime.localeCompare(a.runTime)).slice(0, 20)
        .map(({ groupId: _groupId, ...report }) => report as StoredReport);
    },
    async *exportPosts(groupId) {
      const posts = (await read()).posts.filter((post) => post.groupId === groupId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
      for (const { groupId: _groupId, ...post } of posts) yield post as StoredPost;
    },
  };
}
