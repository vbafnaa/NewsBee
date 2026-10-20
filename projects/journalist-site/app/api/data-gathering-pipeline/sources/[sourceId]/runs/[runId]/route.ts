import { auth, isAdminEmail } from "@/auth";
import { readJson } from "@/data-gathering-pipeline/drive";
import { getRun } from "@/data-gathering-pipeline/store";
import type { PipelineStage } from "@/data-gathering-pipeline/types";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sourceId: string; runId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!(await isAdminEmail(session?.user?.email))) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    const { sourceId, runId } = await context.params;
    const run = await getRun(runId);
    if (!run || run.kind !== "source" || run.source_id !== sourceId) {
      return Response.json({ detail: "Source run was not found" }, { status: 404 });
    }
    const artifacts: Partial<Record<PipelineStage, unknown>> = {};
    for (const stage of ["gather", "normalize"] as const) {
      const fileId = run.stages[stage]?.drive_file_id;
      if (fileId) artifacts[stage] = await readJson(fileId);
    }
    return Response.json({ artifacts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Source pipeline artifacts could not be loaded", error);
    return Response.json({ detail: "Could not load source pipeline artifacts from Drive" }, { status: 503 });
  }
}
