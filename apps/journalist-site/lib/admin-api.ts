import { after } from "next/server";
import { logger } from "@/pipeline/core/log";
import { queueNextJob } from "./pipeline-queue";
import { callNextJob } from "./job-chain";
import type { OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { dispatchPlan } from "@/pipeline/orchestration/dispatch";
import { recordSchedulerSafely } from "@/pipeline/orchestration/scheduler";
import { currentPrincipal, operatorGuard, signedInGuard } from "./admin-session";
import { redact, safeError } from "@/pipeline/core/redaction";
import { authorizePaidAction } from "@/pipeline/accounts/execution";
import { pipelineDeps } from "./pipeline";
import { internalGuard, internalUnlocked } from "./internal-session";
import { getDatabase } from "@/pipeline/storage/mongo";
import { statusFor } from "./admin-error-status";
import { withSiteWriter } from "../../../shared/restore-maintenance";
import { assertLocationInScope, resolveLocationScope, type LocationScope } from "@/pipeline/publications/newsroom-scope";

const log = logger("admin-api");

async function authenticatedRoute(
  request: Request,
  handler: (deps: OrchestratorDeps) => Promise<unknown>,
  guard: (request: Request) => Promise<Response | null>,
  errorContext?: () => { stage: string; locationId?: string; storyId?: string },
) {
  const denied = await guard(request);
  if (denied) return denied;
  try {
    const deps = await pipelineDeps();
    const principal = await currentPrincipal();
    if (!principal) return Response.json({ detail: "Sign in as an approved journalist." }, { status: 401 });
    const paidAction = new URL(request.url).pathname.match(/\/runs\/([^/]+)\/(authoring|finish|resume|map-stage|actions|jobs\/[^/]+\/retry)$/);
    if (request.method === "POST" && paidAction) {
      const body = paidAction[2] === "actions" ? await request.clone().json().catch(() => ({})) as { action?: string } : {};
      if (!["include", "exclude", "pin"].includes(body.action ?? "")) await authorizePaidAction(deps.db, decodeURIComponent(paidAction[1]), principal);
    }
    const result = await withSiteWriter(deps.db, () => handler({ ...deps, principal }));
    const response = result instanceof Response ? result : Response.json(redact(result));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const status = statusFor(error);
    const detail = safeError(error);
    const context = errorContext?.();
    if (status === 500) log.error("admin_request_failed", { path: new URL(request.url).pathname, ...context, error: detail });
    return Response.json({ detail, ...context }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}

/** Operator-only route: checks the session, builds pipeline deps, and returns JSON or a clear error. */
export async function adminRoute(
  request: Request,
  handler: (deps: OrchestratorDeps) => Promise<unknown>,
  errorContext?: () => { stage: string; locationId?: string; storyId?: string },
) {
  return authenticatedRoute(request, handler, operatorGuard, errorContext);
}

/** Publication-scoped route: admits signed-in users, then requires the handler to enforce publication access. */
export async function publicationRoute(
  request: Request,
  handler: (deps: OrchestratorDeps) => Promise<unknown>,
  errorContext?: () => { stage: string; locationId?: string; storyId?: string },
) {
  return authenticatedRoute(request, handler, signedInGuard, errorContext);
}

/**
 * Community-scoped route for the journalist workspace: operators as before, or a journalist
 * acting from a newsroom they belong to (`?publication=<id>`). The handler receives the scope
 * and must check every item's community against it.
 */
export async function newsroomScopedRoute(
  request: Request,
  handler: (deps: OrchestratorDeps, scope: LocationScope) => Promise<unknown>,
  errorContext?: () => { stage: string; locationId?: string; storyId?: string },
) {
  return authenticatedRoute(request, async (deps) => handler(deps,
    await resolveLocationScope(deps.db, deps.principal!, new URL(request.url).searchParams.get("publication"))), signedInGuard, errorContext);
}

/**
 * Read-only source-run data: as internal map data (operators or the shared internal password), or for a journalist
 * reviewing a community their newsroom covers (`?publication=`).
 */
export async function sourceRunReadRoute(request: Request, locationId: string, handler: (deps: Pick<OrchestratorDeps, "db">) => Promise<unknown>) {
  if (await internalUnlocked()) return internalRoute(request, handler);
  if (!new URL(request.url).searchParams.get("publication")) return internalRoute(request, handler);
  return authenticatedRoute(request, async (deps) => {
    assertLocationInScope(await resolveLocationScope(deps.db, deps.principal!, new URL(request.url).searchParams.get("publication")), locationId, "Community");
    return handler({ db: deps.db });
  }, signedInGuard);
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
        // An idle consumer needs a fresh delivery, not a recursive HTTP recovery chain.
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
