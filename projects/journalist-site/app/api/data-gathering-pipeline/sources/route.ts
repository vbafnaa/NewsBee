import { auth, getMongoDatabase, getOutputChannel, isAdminEmail, listConfiguredSources } from "@/auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await auth();
    if (!(await isAdminEmail(session?.user?.email))) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    const channel = await getOutputChannel();
    const state = await (await getMongoDatabase()).collection("source_ingestion_state")
      .find({ channel_id: channel.id }, { projection: { _id: 0 } })
      .toArray();
    const bySource = new Map(state.map((entry) => [
      `${entry.source_id}:${entry.location_id}`,
      {
        sourceId: entry.source_id,
        locationId: entry.location_id,
        lastIngestedAt: entry.last_ingested_at,
        periodStart: entry.period_start,
        periodEnd: entry.period_end,
        status: entry.status,
      },
    ]));
    const sources = await listConfiguredSources();
    return Response.json({
      sources: sources.map((source) => ({
        ...source,
        selected: channel.selectedSourceIds.includes(source.id),
        ingestion: [...bySource.values()].filter((entry) => entry.sourceId === source.id),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Pipeline sources could not be loaded", error);
    return Response.json({ detail: "Could not load pipeline sources" }, { status: 503 });
  }
}
