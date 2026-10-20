import { timingSafeEqual } from "node:crypto";
import { pipelineDeps } from "@/lib/pipeline";
import { logger } from "@/pipeline/core/log";
import { tick } from "@/pipeline/orchestration/orchestrator";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const log = logger("scheduler");

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Vercel Cron (GET) and the local poller (POST): run ready pipeline jobs. */
async function handle(request: Request) {
  if (!authorized(request)) return Response.json({ detail: "Unauthorized" }, { status: 401 });
  try {
    const result = await tick(await pipelineDeps(), { budgetMs: 30_000 });
    return Response.json(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("tick_failed", { error: detail });
    return Response.json({ detail }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
