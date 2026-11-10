import { internalRoute } from "@/lib/admin-api";
import { buildEditionMap, editionMapList, editionMaps } from "@/pipeline/editions/edition-map";
import { runs } from "@/pipeline/orchestration/runs";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return internalRoute(request, async ({ db }) => {
    const selected = new URL(request.url).searchParams.get("run");
    const run = await runs(db).findOne({ location_id: locationId, ...(selected ? { _id: selected } : {}) }, { sort: { created_at: -1 } });
    if (selected && !run) return Response.json({ detail: "Run not found for this location." }, { status: 404 });
    const map = !run ? null : (run.status === "published" || run.status === "built")
      ? await editionMaps(db).findOne({ _id: run._id, location_id: locationId }) ?? await buildEditionMap(db, run._id)
      : await buildEditionMap(db, run._id);
    return { map, editions: await editionMapList(db, locationId) };
  });
}
