import type { StoredReport } from "@/lib/db";
import { storage } from "@/lib/storage";
import { findGroup, notFound, type GroupContext } from "@/lib/groups";
import { apiError, jsonRequest } from "@/lib/http";
import { InputError, postKey, validateReport } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: GroupContext) {
  try {
    const report = validateReport(await jsonRequest(request, 2_000_000));
    const store = storage();
    const group = await findGroup(store, context);
    if (!group) return notFound();
    const groupPath = new URL(group.url).pathname;
    for (const post of report.posts) {
      if (post.permalink && new URL(post.permalink).pathname.startsWith("/groups/") && !new URL(post.permalink).pathname.startsWith(`${groupPath}/`)) {
        throw new InputError("Post permalink must belong to the specified group");
      }
    }
    const refs = new Map(report.posts.map((post) => [post.ref, postKey(post)]));
    const chronological = report.scans.find((scan) => scan.sort === "CHRONOLOGICAL")!;
    const recent = report.scans.find((scan) => scan.sort === "RECENT_ACTIVITY")!;
    const classified = (postRefs: string[]) => [...new Set(postRefs.map((ref) => refs.get(ref)!))];
    const seen = new Set([...chronological.postRefs, ...recent.postRefs]);
    if (report.posts.some((post) => !seen.has(post.ref))) throw new InputError("Every post must appear in at least one scan");
    const stored: StoredReport = {
      id: `${group.id}:${report.runTime}`, groupId: group.id, runTime: report.runTime,
      windowStart: report.windowStart, windowEnd: report.windowEnd, status: report.status,
      chronologicalStatus: chronological.status, recentActivityStatus: recent.status,
      issues: [ ...report.issues, ...report.scans.filter((scan) => scan.reason).map((scan) => `${scan.sort}: ${scan.reason}`) ],
      lastHour: classified(report.posts.filter((post) => post.publishedAt && post.publishedAt >= report.windowStart && post.publishedAt < report.windowEnd).map((post) => post.ref)),
      recentActivityTop10: classified(recent.postRefs),
      unknownPublicationTime: classified(report.posts.filter((post) => !post.publishedAt).map((post) => post.ref)),
      createdAt: new Date().toISOString(),
    };
    const created = await store.saveReport(group.id, report, stored);
    return Response.json({ reportId: stored.id, accepted: report.posts.length, lastHour: stored.lastHour.length, recentActivityTop10: stored.recentActivityTop10.length, unknownPublicationTime: stored.unknownPublicationTime.length }, { status: created ? 201 : 200 });
  } catch (error) { return apiError(error); }
}
