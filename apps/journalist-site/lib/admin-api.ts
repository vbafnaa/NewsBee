import { after } from "next/server";
import { logger } from "@/pipeline/core/log";
import { RunOptionsError } from "@/pipeline/core/run-options";
import { queueNextJob } from "./pipeline-queue";
import { callNextJob } from "./job-chain";
import { LocationBusy } from "@/pipeline/communities/locations";
import { InvalidSourceLink } from "@/pipeline/connectors/manual-links";
import type { OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { RunConflict } from "@/pipeline/orchestration/runs";
import { dispatchPlan } from "@/pipeline/orchestration/dispatch";
import { recordSchedulerSafely } from "@/pipeline/orchestration/scheduler";
import { adminGuard, currentPrincipal } from "./admin-session";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";
import { redact, safeError } from "@/pipeline/core/redaction";
import { authorizePaidAction } from "@/pipeline/accounts/execution";
import { pipelineDeps } from "./pipeline";
import { internalGuard } from "./internal-session";
import { getDatabase } from "@/pipeline/storage/mongo";

const log = logger("admin-api");

function statusFor(error: unknown) {
  if (error instanceof ExecutionBlocked) return 403;
  if ((error as { code?: number })?.code === 11000) return 409;
  if (error instanceof LocationBusy || error instanceof RunConflict) return 409;
  if (error instanceof InvalidSourceLink) return 422;
  if (error instanceof RunOptionsError) return 400;
  const message = error instanceof Error ? error.message : "";
  if (/^(Location is not onboarded|Census place is not available|No published|No active withdrawal|Unknown run|Unknown source|Unknown video request)/.test(message)) return 404;
  if (/^(A public correction reason|Withdrawal already exists|Invalid )/.test(message)) return 400;
  return 500;
}

/** Admin-only route: checks the session, builds pipeline deps, and returns JSON or a clear error. */
export async function adminRoute(request: Request, handler: (deps: OrchestratorDeps) => Promise<unknown>) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  try {
    const deps = await pipelineDeps();
    const principal = await currentPrincipal();
    if (!principal) return Response.json({ detail: "Sign in as an approved journalist." }, { status: 401 });
    const paidAction = new URL(request.url).pathname.match(/\/runs\/([^/]+)\/(authoring|finish|resume|actions|jobs\/[^/]+\/retry)$/);
    if (request.method === "POST" && paidAction) {
      const body = paidAction[2] === "actions" ? await request.clone().json().catch(() => ({})) as { action?: string } : {};
      if (!["include", "exclude", "pin"].includes(body.action ?? "")) await authorizePaidAction(deps.db, decodeURIComponent(paidAction[1]), principal);
    }
    const result = await handler({ ...deps, principal });
    const response = result instanceof Response ? result : Response.json(redact(result));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const status = statusFor(error);
    const detail = safeError(error);
    if (status === 500) log.error("admin_request_failed", { path: new URL(request.url).pathname, error: detail });
    return Response.json({ detail }, { status });
  }
}

/** Password-only, read-only map data. Never builds model runtimes or grants admin access. */
export async function internalRoute(request: Request, handler: (deps: Pick<OrchestratorDeps, "db">) => Promise<unknown>) {
  let response: Response;
  try {
    if (!["GET", "HEAD"].includes(request.method)) {
      response = Response.json({ detail: "Map data is read-only." }, { status: 405 });
    } else {
      const denied = await internalGuard();
      if (denied) response = denied;
      else {
        const result = await handler({ db: await getDatabase() });
        response = result instanceof Response ? result : Response.json(result);
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const status = statusFor(error);
    if (status === 500) log.error("map_request_failed", { path: new URL(request.url).pathname, error: detail });
    response = Response.json({ detail: status === 500 ? "Map data is temporarily unavailable." : detail }, { status });
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/** Queue cloud jobs; local development chains one job per HTTP invocation. */
export function kickPipeline(deps: OrchestratorDeps, requestUrl: string) {
  after(async () => {
    try {
      if (deps.settings.mode === "cloud") {
        const { send } = await dispatchPlan(deps.db, deps.settings.collectConcurrency);
        for (let index = 0; index < Math.max(1, send); index += 1) await queueNextJob();
      } else {
        await callNextJob(requestUrl);
      }
      await recordSchedulerSafely(deps.db, "kick", null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.error("kick_failed", { error: detail });
      await recordSchedulerSafely(deps.db, "kick", detail);
    }
  });
}

export async function jsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}
