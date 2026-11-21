import { desktopVideoCredentials } from "@/pipeline/accounts/runtime";
import { safeError } from "@/pipeline/core/redaction";
import type { OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

export async function releaseVideoStatus(deps: OrchestratorDeps) {
  let desktop: { state: "configured" | "not_configured" | "error"; detail: string | null };
  try {
    const credentials = await desktopVideoCredentials(deps, deps.principal!);
    desktop = {
      state: credentials.selected ? "configured" : "not_configured",
      detail: credentials.selectionUnavailable
        ? "Personal Desktop Video credentials cannot be read. Repair the saved provider settings before generating."
        : null,
    };
  } catch (error) {
    desktop = { state: "error", detail: safeError(error) };
  }

  const recentAfter = Date.now() - 30 * 24 * 60 * 60_000;
  const jobs = await deps.db.collection<{
    status?: string;
    provider?: string;
    funding_identity?: string;
    created_at?: number;
  }>(COLLECTIONS.videoJobs).find({
    publication_id: { $exists: true },
    release_id: { $exists: true },
    story_id: { $exists: true },
  }).project({
    _id: 0,
    status: 1,
    provider: 1,
    funding_identity: 1,
    created_at: 1,
  }).toArray();
  const statuses: Record<string, number> = {};
  const providers: Record<string, number> = {};
  const funding: Record<string, number> = {};
  for (const job of jobs) {
    increment(statuses, job.status ?? "unknown");
    increment(providers, job.provider ?? "fal");
    increment(funding, job.funding_identity ?? "personal");
  }
  return {
    desktop,
    total: jobs.length,
    recent: jobs.filter((job) => (job.created_at ?? 0) >= recentAfter).length,
    statuses,
    providers,
    funding,
    auditEvents: await deps.db.collection("journalist_funding_audit").countDocuments({
      role: { $regex: "^release-video-" },
    }),
  };
}
