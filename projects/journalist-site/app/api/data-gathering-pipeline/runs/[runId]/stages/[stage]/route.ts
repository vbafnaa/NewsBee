import { auth, getOutputChannel, isAdminEmail } from "@/auth";
import { executeStage } from "@/data-gathering-pipeline/stages";
import { claimStage, failStage, finishStage, getRun } from "@/data-gathering-pipeline/store";
import { editionStages, sourceStages } from "@/data-gathering-pipeline/types";
import type { PipelineStage } from "@/data-gathering-pipeline/types";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ runId: string; stage: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 });
  }
  try {
    const session = await auth();
    if (!(await isAdminEmail(session?.user?.email))) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    const { runId, stage: rawStage } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      return Response.json({ detail: "Pipeline run identifier is invalid" }, { status: 400 });
    }
    const channel = await getOutputChannel();
    const run = await getRun(runId, channel.id);
    if (!run) return Response.json({ detail: "Pipeline run was not found" }, { status: 404 });
    const valid = run.kind === "source"
      ? sourceStages.some((stage) => stage === rawStage)
      : editionStages.some((stage) => stage === rawStage);
    if (!valid) {
      return Response.json({ detail: "Stage is invalid for this run" }, { status: 400 });
    }
    const stage = rawStage as PipelineStage;
    if (run.current_stage !== stage) {
      return Response.json({ detail: `The next stage for this run is ${run.current_stage ?? "complete"}` }, { status: 409 });
    }
    const claimed = await claimStage(runId, channel.id, stage);
    if (!claimed) {
      return Response.json({ detail: "This stage is already running or has already completed" }, { status: 409 });
    }
    try {
      const result = await executeStage(claimed, stage);
      await finishStage(claimed, stage, result.nextStage, result.driveFileId);
      return Response.json({ run: await getRun(runId, channel.id) }, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      await failStage(claimed, stage, error);
      console.error(`Pipeline stage failed run=${runId} stage=${stage}`, error);
      return Response.json({ detail: error instanceof Error ? error.message : "Pipeline stage failed" }, { status: 502 });
    }
  } catch (error) {
    console.error("Pipeline stage request failed", error);
    return Response.json({ detail: "Could not run pipeline stage" }, { status: 503 });
  }
}
