import { after } from "next/server";
import { logger } from "@/pipeline/core/log";
import { LocationBusy } from "@/pipeline/communities/locations";
import { InvalidSourceLink } from "@/pipeline/connectors/manual-links";
import { tick, type OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { RunConflict } from "@/pipeline/orchestration/runs";
import { adminGuard } from "./admin-session";
import { pipelineDeps } from "./pipeline";

const log = logger("admin-api");

function statusFor(error: unknown) {
  if (error instanceof LocationBusy || error instanceof RunConflict) return 409;
  if (error instanceof InvalidSourceLink) return 422;
  const message = error instanceof Error ? error.message : "";
  if (/^(Location is not onboarded|Census place is not available|No published|No active withdrawal|Unknown run)/.test(message)) return 404;
  if (/^(A public correction reason|Withdrawal already exists|Invalid )/.test(message)) return 400;
  return 500;
}

/** Admin-only route: checks the session, builds pipeline deps, and returns JSON or a clear error. */
export async function adminRoute(request: Request, handler: (deps: OrchestratorDeps) => Promise<unknown>) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  try {
    const result = await handler(await pipelineDeps());
    return result instanceof Response ? result : Response.json(result);
  } catch (error) {
    const status = statusFor(error);
    const detail = error instanceof Error ? error.message : String(error);
    if (status === 500) log.error("admin_request_failed", { path: new URL(request.url).pathname, error: detail });
    return Response.json({ detail }, { status });
  }
}

/** Start running queued jobs right after responding instead of waiting for the next cron tick. */
export function kickPipeline(deps: OrchestratorDeps, requestUrl: string) {
  after(async () => {
    try {
      if (deps.settings.mode === "cloud") {
        const secret = deps.settings.cronSecret;
        if (!secret) throw new Error("CRON_SECRET is required to dispatch cloud pipeline jobs");
        const response = await fetch(new URL("/api/pipeline/tick", requestUrl), {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}` },
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Scheduler returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
      } else {
        await tick(deps, { budgetMs: 20_000 });
      }
    } catch (error) {
      log.error("kick_failed", { error: error instanceof Error ? error.message : String(error) });
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
