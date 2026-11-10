import { adminRoute, jsonBody, kickPipeline } from "@/lib/admin-api";
import { currentAdmin } from "@/lib/admin-session";
import { reassemble, recollectSource, rewriteStory, setOverride } from "@/pipeline/orchestration/inspect";
import { rerunImageStage } from "@/pipeline/orchestration/orchestrator";

type Context = { params: Promise<{ runId: string }> };
export const maxDuration = 300;

/**
 * Rerun part of a run:
 *   { action: "recollect", source_id }        collect one source again
 *   { action: "reassemble" }                   assemble, rank and write again (keeps collected items)
 *   { action: "rewrite", story_id }            extract details again and rewrite one story
 *   { action: "images" }                       rerun only image sourcing before publication
 *   { action: "include" | "exclude" | "pin", item_id, on? }  force an item in or out, or pin it to the top of its section
 */
export async function POST(request: Request, context: Context) {
  const { runId } = await context.params;
  return adminRoute(request, async (deps) => {
    const body = await jsonBody<{ action?: unknown; source_id?: unknown; story_id?: unknown; item_id?: unknown; on?: unknown }>(request);
    const by = (await currentAdmin()) ?? "editor";
    let result: unknown;
    if (body.action === "recollect" && typeof body.source_id === "string") result = await recollectSource(deps.db, runId, body.source_id, by);
    else if (body.action === "reassemble") result = await reassemble(deps.db, runId, by);
    else if (body.action === "rewrite" && typeof body.story_id === "string") result = await rewriteStory(deps.db, runId, body.story_id, by);
    else if (body.action === "images") result = await rerunImageStage(deps, runId, by);
    else if ((body.action === "include" || body.action === "exclude" || body.action === "pin") && typeof body.item_id === "string") result = await setOverride(deps.db, runId, body.action, body.item_id, body.on !== false);
    else throw new Error("Invalid action");
    kickPipeline(deps, request.url);
    return result;
  });
}
