import { jsonBody, kickPipeline, publicationRoute } from "@/lib/admin-api";
import { defaultRunOptions } from "@/pipeline/core/run-options";
import { locationReadinessForIds } from "@/pipeline/communities/readiness";
import { listLocations } from "@/pipeline/communities/locations";
import {
  listPublicationGenerations,
  listPublicationDrafts,
  MAX_PUBLICATION_GENERATION_LOCATIONS,
  publicationGenerationChildren,
  publicationGenerationDraft,
  recoverStartingPublicationGenerations,
  startPublicationGeneration,
} from "@/pipeline/publications/generation";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { activePublicationSupport } from "@/pipeline/publications/support";
import { publicationReaderMetadata } from "@/pipeline/publications/preview";
import { GlobalAdmissionConflict, SHARED_GENERATION_BUSY_DETAIL } from "@/pipeline/accounts/execution";

type Context = { params: Promise<{ publicationId: string }> };

export async function GET(request: Request, context: Context) {
  const { publicationId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const principal = deps.principal!;
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      principal,
      publicationId,
      request.method === "GET"
        ? "Review publication generation status in the support workspace"
        : "Start publication generation from the support workspace",
      request.method === "GET" ? "read" : "write",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const recovered = await recoverStartingPublicationGenerations(deps);
    const profiles = await listLocations(deps.db);
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const selected = access.channel.selectedLocationIds
      .map((id) => byId.get(id))
      .filter((profile): profile is NonNullable<typeof profile> => Boolean(profile));
    const query = new URL(request.url).searchParams;
    const selectedDraftId = query.get("draft");
    const [locations, generations, history, draft] = await Promise.all([
      locationReadinessForIds(deps.db, selected.map(({ id, name }) => ({ id, name }))),
      listPublicationGenerations(deps.db, publicationId, 10, query.get("generation")),
      listPublicationDrafts(deps.db, publicationId, query.get("draftBefore")),
      selectedDraftId === "" ? Promise.resolve(null) : publicationGenerationDraft(deps.db, publicationId, selectedDraftId),
    ]);
    if (recovered || generations.some((generation) =>
      ["starting", "running", "combining"].includes(generation.status))) {
      kickPipeline(deps, request.url);
    }
    const children = await publicationGenerationChildren(deps.db, generations.map((generation) => generation._id));
    const support = access.context.role === "privileged"
      ? await activePublicationSupport(deps.db, principal, publicationId) : null;
    return {
      publication: {
        id: access.channel.id,
        name: access.channel.name,
        role: access.context.role,
        canWrite: access.context.role !== "privileged" || Boolean(support),
        supportExpiresAt: support?.expires_at ?? null,
      },
      limits: { maxLocations: MAX_PUBLICATION_GENERATION_LOCATIONS },
      recovery: { personalFundingAllowed: principal.role !== "editor", managedFundingAllowed: principal.role === "editor" },
      execution: { funding: principal.role === "editor" ? "managed" : principal.role === "admin" ? "personal" : "owner" },
      ...publicationReaderMetadata(),
      locations,
      generations: generations.map((generation) => ({
        ...generation,
        children: children.filter((child) => child.publication_generation_id === generation._id),
      })),
      draft,
      drafts: history.drafts,
      draftsNextCursor: history.nextCursor,
      defaultOptions: { ...defaultRunOptions(), paid: { ...defaultRunOptions().paid, model: 200 } },
    };
  });
}

export async function POST(request: Request, context: Context) {
  const { publicationId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const body = await jsonBody<{
      locationIds?: unknown;
      window?: unknown;
      options?: unknown;
      idempotencyKey?: unknown;
    }>(request);
    if (!Array.isArray(body.locationIds) || body.locationIds.some((id) => typeof id !== "string")) {
      return Response.json({ detail: "Choose valid publication locations." }, { status: 422 });
    }
    const result = await startPublicationGeneration(deps, deps.principal!, {
      publicationId,
      locationIds: body.locationIds as string[],
      window: body.window as [string, string],
      options: body.options,
      idempotencyKey: String(body.idempotencyKey ?? ""),
    }).catch((error: unknown) => {
      if (error instanceof GlobalAdmissionConflict) return null;
      throw error;
    });
    if (!result) return Response.json({
      code: "generation_busy", detail: SHARED_GENERATION_BUSY_DETAIL,
    }, { status: 409 });
    if (result.started) kickPipeline(deps, request.url);
    return Response.json(result, { status: result.started ? 201 : 200 });
  });
}
