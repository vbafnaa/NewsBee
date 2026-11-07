import { adminRoute } from "@/lib/admin-api";
import { RunConflict } from "@/pipeline/orchestration/runs";

export const maxDuration = 300;

/** Batch admission cannot reserve multiple unfinished newsroom runs. */
export async function POST(request: Request) {
  return adminRoute(request, async () => { throw new RunConflict("Batch runs are disabled. Start one location; only one unfinished map or edition run may occupy the newsroom."); });
}
