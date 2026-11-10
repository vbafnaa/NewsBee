import { adminRoute } from "@/lib/admin-api";
import { editionMapList, editionMaps, writeEditionMap } from "@/pipeline/editions/edition-map";
import { runs } from "@/pipeline/orchestration/runs";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";

/** The internal edition map for a run (?run=), else the latest run; includes errors and draft states the reader page hides. */
export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  return adminRoute(request, async ({ db }) => {
    const selected = new URL(request.url).searchParams.get("run");
    const run = await runs(db).findOne({ location_id: locationId, ...(selected ? { _id: selected } : {}) }, { sort: { created_at: -1 } });
    const runId = run?._id;
    if (selected && !run) return Response.json({ detail: "Run not found for this location." }, { status: 404 });
    if (!runId) return { map: null, editions: await editionMapList(db, locationId) };
    const map = (run?.status === "published" || run?.status === "built")
      ? (await editionMaps(db).findOne({ _id: runId, location_id: locationId })) ?? await writeEditionMap(db, runId)
      : await writeEditionMap(db, runId);
    return { map, editions: await editionMapList(db, locationId) };
  });
}
