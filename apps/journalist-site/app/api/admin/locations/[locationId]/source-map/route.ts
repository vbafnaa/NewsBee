import { adminRoute, jsonBody, newsroomScopedRoute } from "@/lib/admin-api";
import { assertLocationInScope, NewsroomScopeDenied } from "@/pipeline/publications/newsroom-scope";
import { getLocation } from "@/pipeline/communities/locations";
import { locationDiscovery, refreshDiscovery } from "@/pipeline/discovery/run";
import { sourceInventory } from "@/pipeline/sourcemap/inventory";
import { METHOD_LABELS, resumeSource, reviewChange, saveSourceReview, setSourceStatus, setSourceWindow, sourceMap, type SourceStatus } from "@/pipeline/sourcemap/store";
import { SECTIONS } from "@/pipeline/sourcemap/sections";
import { CONNECTORS, windowOf } from "@/pipeline/connectors/registry";
import { describeWindow, WINDOWS } from "@/pipeline/sourcemap/windows";
import { redact } from "@/pipeline/core/redaction";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";

/** The location's source map grouped by section, with health and how each source was found, plus discovery state. */
export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return newsroomScopedRoute(request, async ({ db }, scope) => {
    assertLocationInScope(scope, locationId, "Community");
    const location = await getLocation(db, locationId);
    const sources = (await sourceInventory(db, locationId)).map((source) => {
      const connector = CONNECTORS[source.reader];
      return { ...source, found_by_label: METHOD_LABELS[source.found_by.method] ?? source.found_by.method, window_label: connector ? describeWindow(windowOf(connector, { type: source.reader, source_id: source.source_id, name: source.name, params: { ...source.params, ...(source.window ? { window: source.window } : {}) } })) : null };
    });
    const windows = Object.entries(WINDOWS).map(([id, value]) => ({ id, label: value.label }));
    // Redaction shortens anything called a reason. A review is a person's own words, so it is returned exactly as saved.
    return Response.json({ sections: SECTIONS, systems: location.systems.filter((system) => system.branches.length).map(({ fscskey, name }) => ({ id: fscskey, name })), sources: sources.map((source) => ({ ...redact(source) as object, review: source.review })), discovery: redact(await locationDiscovery(db, locationId)), windows });
  });
}

/**
 * Change one source: { source_id, status?: active|pinned|paused, note?, window?: {back_days?, ahead_days?} | null },
 * or label it: { source_id, decision?: accept|reject|null, reason_code?: code|null, reason?: string|null }. Text goes
 * only with an Other code, sent together. Rejecting is always a label, so the reason and history are kept; a source
 * with a Reject decision only changes status through its decision.
 */
export async function PATCH(request: Request, context: Context) {
  const { locationId } = await context.params;
  return newsroomScopedRoute(request, async ({ db, principal }, scope) => {
    assertLocationInScope(scope, locationId, "Community");
    await getLocation(db, locationId);
    const body = await jsonBody<{ source_id?: unknown; status?: unknown; note?: unknown; decision?: unknown; reason_code?: unknown; reason?: unknown; window?: { back_days?: unknown; ahead_days?: unknown } | null }>(request);
    if (typeof body.source_id !== "string") throw new Error("Invalid request: send a source_id");
    // Journalists accept or reject sources (recorded with their email); pausing, pinning and look-back windows stay with operators.
    if (!scope.operator && (body.status !== undefined || body.window !== undefined)) {
      throw new NewsroomScopeDenied("Only an operator can pause, pin or change a source's window.");
    }
    if (body.decision !== undefined || body.reason_code !== undefined || body.reason !== undefined) {
      if (body.status !== undefined || body.window !== undefined) throw new Error("Invalid request: send a label on its own");
      const change = reviewChange(body);
      if (!principal) throw new Error("Sign in as an approved journalist.");
      const saved = await saveSourceReview(db, locationId, body.source_id, change, principal.email);
      return Response.json({ updated: body.source_id, ...saved });
    }
    if (typeof body.status === "string") {
      if (!["active", "pinned", "paused", "resume"].includes(body.status)) throw new Error("Invalid status");
      const current = await sourceMap(db).findOne({ _id: `${locationId}:${body.source_id}` }, { projection: { review: 1 } });
      if (current?.review?.decision === "reject") throw new Error("Invalid status: this source is rejected, so change its Decision first");
      if (body.status === "resume") await resumeSource(db, locationId, body.source_id);
      else await setSourceStatus(db, locationId, body.source_id, body.status as SourceStatus, typeof body.note === "string" ? body.note.slice(0, 500) : undefined);
    }
    if (body.window !== undefined) {
      const back = Number(body.window?.back_days), ahead = Number(body.window?.ahead_days);
      const window = body.window === null ? null : {
        ...(Number.isFinite(back) && back > 0 ? { back: { since: "last_edition" as const, maxDays: Math.min(180, Math.round(back)) } } : {}),
        ...(Number.isFinite(ahead) && ahead > 0 ? { ahead: { days: Math.min(60, Math.round(ahead)) } } : {}),
      };
      await setSourceWindow(db, locationId, body.source_id, window && Object.keys(window).length ? window : null);
    }
    return { updated: body.source_id };
  });
}

/** Make every discovery method (or one: { method }) due on the next source map run. */
export async function POST(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    await getLocation(db, locationId);
    const body = await jsonBody<{ method?: unknown }>(request).catch(() => ({} as { method?: unknown }));
    await refreshDiscovery(db, locationId, typeof body.method === "string" ? body.method : undefined);
    return { refreshed: true };
  });
}
