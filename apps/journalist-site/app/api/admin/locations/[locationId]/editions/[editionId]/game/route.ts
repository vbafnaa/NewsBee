import { adminRoute, jsonBody } from "@/lib/admin-api";
import { BeeError, closePreviousBeeGame, editBeeGame, previewBeeGame, shoutoutCandidates } from "@/pipeline/games/save-the-bee";
import { assertStandaloneEditionControl } from "@/pipeline/orchestration/runs";

type Context = { params: Promise<{ locationId: string; editionId: string }> };
export const dynamic = "force-dynamic";
async function handle(request: Request, context: Context) {
  const { locationId, editionId } = await context.params;
  return adminRoute(request, async ({ db, principal }) => {
    try {
      if (request.method === "POST") {
        await assertStandaloneEditionControl(db, locationId, editionId);
        const body = await jsonBody<unknown>(request);
        if (!body || typeof body !== "object" || !("action" in body) || typeof body.action !== "string") {
          throw new BeeError("Invalid game review action.", 422);
        }
        const input = body as Parameters<typeof editBeeGame>[3] | { action: "close-previous" };
        if (input.action === "close-previous") await closePreviousBeeGame(db, locationId, editionId);
        else {
          if (!["save", "regenerate", "approve"].includes(input.action) || !Number.isInteger(input.revision)) {
            throw new BeeError("Invalid game review action.", 422);
          }
          await editBeeGame(db, locationId, editionId, input, principal!.email);
        }
      }
      return { game: await previewBeeGame(db, locationId, editionId), previous: await shoutoutCandidates(db, locationId, editionId) };
    } catch (error) {
      if (error instanceof BeeError) return Response.json({ detail: error.message }, { status: error.status });
      throw error;
    }
  });
}
export const GET = handle;
export const POST = handle;
