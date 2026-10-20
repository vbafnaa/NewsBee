import { auth, getOutputChannel, isAdminEmail } from "@/auth";
import { readLocationIndex } from "@/data-gathering-pipeline/drive";
import { createEditionRun, getCompletedSourceRunsBySource } from "@/data-gathering-pipeline/store";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 });
  }
  try {
    const session = await auth();
    if (!(await isAdminEmail(session?.user?.email))) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body) ||
      typeof (body as Record<string, unknown>).locationId !== "string" ||
      typeof (body as Record<string, unknown>).channelId !== "string") {
      return Response.json({ detail: "Select an output channel and location to create an aggregation run" }, { status: 422 });
    }
    const payload = body as Record<string, string>;
    const channel = await getOutputChannel(payload.channelId);
    const locationId = payload.locationId;
    const location = (await readLocationIndex()).find((entry) => entry.id === locationId);
    if (!location) return Response.json({ detail: "Location was not found in locations.json" }, { status: 422 });
    const sourceRuns = await getCompletedSourceRunsBySource(location.id, channel.selectedSourceIds);
    const latestBySource = new Map<string, (typeof sourceRuns)[number]>();
    for (const run of sourceRuns) {
      if (run.source_id && !latestBySource.has(run.source_id)) latestBySource.set(run.source_id, run);
    }
    if (latestBySource.size === 0) {
      return Response.json({ detail: "Run and normalize at least one selected source for this location first" }, { status: 422 });
    }
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const finalDay = new Date(tomorrow);
    finalDay.setDate(finalDay.getDate() + 6);
    const run = await createEditionRun(
      channel.id,
      channel.driveFolderId,
      location.id,
      location.name,
      [...latestBySource.values()].map((sourceRun) => sourceRun._id),
      tomorrow.toISOString().slice(0, 10),
      finalDay.toISOString().slice(0, 10),
    );
    return Response.json({ run }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Edition pipeline run could not be created", error);
    return Response.json({ detail: "Could not create the edition pipeline run" }, { status: 503 });
  }
}
