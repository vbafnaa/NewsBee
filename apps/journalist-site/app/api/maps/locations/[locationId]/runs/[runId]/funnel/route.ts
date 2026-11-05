import { internalRoute } from "@/lib/admin-api";
import { itemTrail, runFunnel, stageDetail } from "@/pipeline/trace/funnel";
import { runs } from "@/pipeline/orchestration/runs";

type Context = { params: Promise<{ locationId: string; runId: string }> };
export const dynamic = "force-dynamic";

/** The run's funnel, or one stage's detail (?stage=), or one item's trail (?item=). `latest` means the newest run. */
export async function GET(request: Request, context: Context) {
  const { locationId, runId } = await context.params;
  return internalRoute(request, async ({ db }) => {
    const query = new URL(request.url).searchParams;
    const notFound = () => Response.json({ detail: "Run not found for this location." }, { status: 404 });
    const funnel = () => runFunnel(db, locationId, runId === "latest" ? null : runId);
    const stage = query.get("stage"), item = query.get("item");
    if (!stage && !item) return await funnel() ?? notFound();
    if (!(await runs(db).findOne({ _id: runId, location_id: locationId }, { projection: { _id: 1 } }))) return notFound();
    if (item) return await itemTrail(db, runId, item) ?? Response.json({ detail: "This item isn't listed." }, { status: 404 });
    return await stageDetail(db, runId, stage!, { topic: query.get("topic"), page: Number(query.get("page") ?? 0) }) ?? notFound();
  });
}
