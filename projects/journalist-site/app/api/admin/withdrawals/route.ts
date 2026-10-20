import { adminRoute, jsonBody } from "@/lib/admin-api";
import { latestPublished } from "@/pipeline/editions/authoring";
import { list, restore, withdraw } from "@/pipeline/editorial/withdrawals";
import { logger } from "@/pipeline/core/log";
import type { OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { publishToChannels } from "@/pipeline/orchestration/publish";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

/** Rewrite the location's latest edition in every channel so the correction shows right away. */
async function republish(deps: OrchestratorDeps, locationId: string) {
  const edition = await latestPublished({ db: deps.db, model: deps.model, settings: deps.settings, log: logger("withdrawals") }, locationId);
  return edition ? publishToChannels(deps.db, deps.store, edition) : [];
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const locationId = params.get("location") ?? "";
  return adminRoute(request, async ({ db }) => ({ withdrawals: await list(db, locationId, params.get("all") === "1") }));
}

/** Withdraw a published story with a public correction reason. */
export async function POST(request: Request) {
  return adminRoute(request, async (deps) => {
    const body = await jsonBody<{ edition_id?: unknown; story_id?: unknown; reason?: unknown }>(request);
    if (typeof body.edition_id !== "string" || typeof body.story_id !== "string" || typeof body.reason !== "string") {
      throw new Error("Invalid withdrawal: edition_id, story_id and reason are required");
    }
    await withdraw(deps.db, body.edition_id, body.story_id, body.reason);
    const edition = await deps.db.collection(COLLECTIONS.editions).findOne({ id: body.edition_id }, { projection: { location_id: 1 } });
    return { channels: await republish(deps, String(edition?.location_id)) };
  });
}

/** Restore a withdrawn story. */
export async function DELETE(request: Request) {
  return adminRoute(request, async (deps) => {
    const body = await jsonBody<{ location_id?: unknown; story_id?: unknown }>(request);
    if (typeof body.location_id !== "string" || typeof body.story_id !== "string") throw new Error("Invalid restore: location_id and story_id are required");
    await restore(deps.db, body.location_id, body.story_id);
    return { channels: await republish(deps, body.location_id) };
  });
}
