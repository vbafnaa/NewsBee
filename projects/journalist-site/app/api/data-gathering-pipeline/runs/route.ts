import {
  auth,
  getOutputChannel,
  isAdminEmail,
  listConfiguredSources,
} from "@/auth";
import { readLocationIndex } from "@/data-gathering-pipeline/drive";
import { createSourceRun, listRuns } from "@/data-gathering-pipeline/store";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

async function authorized() {
  const session = await auth();
  return isAdminEmail(session?.user?.email);
}

export async function GET() {
  try {
    if (!(await authorized())) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    const channel = await getOutputChannel();
    return Response.json({ runs: await listRuns(channel.id) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Pipeline runs could not be loaded", error);
    return Response.json({ detail: "Could not load pipeline runs" }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 });
  }
  try {
    if (!(await authorized())) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
    }
    const payload = body as Record<string, unknown>;
    if (typeof payload.sourceId !== "string" || typeof payload.locationId !== "string") {
      return Response.json({ detail: "Select a source and location" }, { status: 422 });
    }
    const channel = await getOutputChannel();
    if (!channel.selectedSourceIds.includes(payload.sourceId)) {
      return Response.json({ detail: "Select this source in the output channel before triggering it" }, { status: 422 });
    }
    const source = (await listConfiguredSources()).find((entry) => entry.id === payload.sourceId);
    if (!source) return Response.json({ detail: "Configured source was not found" }, { status: 404 });
    const location = (await readLocationIndex()).find((entry) => entry.id === payload.locationId);
    if (!location) return Response.json({ detail: "Location was not found in locations.json" }, { status: 422 });
    if (source.kind === "government" && source.location !== location.id) {
      return Response.json({ detail: "Government meeting sources can only run for their configured location" }, { status: 422 });
    }

    const run = await createSourceRun(channel.id, channel.driveFolderId, source, location.id, location.name);
    return Response.json({ run }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Source run could not be created", error);
    return Response.json({ detail: "Could not create the source run" }, { status: 503 });
  }
}
