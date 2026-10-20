import {
  auth,
  getMongoDatabase,
  isAdminEmail,
  listConfiguredSources,
} from "@/auth";
import { listSourceRuns } from "@/data-gathering-pipeline/store";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sourceId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!(await isAdminEmail(session?.user?.email))) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    const { sourceId } = await context.params;
    const source = (await listConfiguredSources()).find((entry) => entry.id === sourceId);
    if (!source) return Response.json({ detail: "Configured source was not found" }, { status: 404 });
    const database = await getMongoDatabase();
    const ingestionRecords = await database.collection("source_ingestion_state").find(
      { source_id: sourceId },
      { projection: { _id: 0 } },
    ).sort({ last_ingested_at: -1 }).toArray();
    const latestByLocation = new Map<string, typeof ingestionRecords[number]>();
    for (const record of ingestionRecords) {
      const existing = latestByLocation.get(record.location_id);
      if (!existing || new Date(record.last_ingested_at).valueOf() >
        new Date(existing.last_ingested_at).valueOf()) {
        latestByLocation.set(record.location_id, record);
      }
    }
    const runs = await listSourceRuns(sourceId);
    return Response.json({
      source,
      ingestion: [...latestByLocation.values()],
      runs,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Source pipeline details could not be loaded", error);
    return Response.json({ detail: "Could not load source pipeline details" }, { status: 503 });
  }
}
