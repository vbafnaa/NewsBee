import { createOutputChannel, getOutputChannel, listOutputChannels, updateOutputChannel } from "@/auth";
import { adminGuard } from "@/lib/admin-session";
import { pipelineDeps } from "@/lib/pipeline";
import { listLocations } from "@/pipeline/communities/locations";
import { logger } from "@/pipeline/core/log";
import { latestPublished } from "@/pipeline/editions/authoring";
import { addLocationsToChannel, createChannelFolder } from "@/pipeline/orchestration/publish";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validName(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.trim().length <= 120;
}

function validUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  try {
    const channels = await listOutputChannels();
    const channel = channels.find((item) => item.id === "reader-site") ?? await getOutputChannel();
    const locations = (await listLocations((await pipelineDeps()).db)).map(({ id, name }) => ({ id, name }));
    return Response.json({ channel, channels, locations }, { headers: noStore });
  } catch (error) {
    console.error("Output channels could not be loaded", error);
    return Response.json({ detail: "Output channels could not be loaded" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!isRecord(body)) return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
    const { id, name, url } = body;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
      return Response.json({ detail: "Channel ID must be a lowercase slug with 2–64 letters, numbers, or hyphens" }, { status: 422 });
    }
    if (!validName(name)) return Response.json({ detail: "Enter a channel name of up to 120 characters" }, { status: 422 });
    if (!validUrl(url)) return Response.json({ detail: "Enter a valid HTTP or HTTPS channel URL without credentials" }, { status: 422 });
    if ((await listOutputChannels()).some((channel) => channel.id === id)) {
      return Response.json({ detail: "An output channel with this ID already exists" }, { status: 409 });
    }
    const deps = await pipelineDeps();
    const driveFolderId = await createChannelFolder(deps.store, deps.settings.pipelineDriveFolderId, id);
    const channel = await createOutputChannel({
      id,
      name: name.trim(),
      url: new URL(url).toString().replace(/\/$/, ""),
      driveFolderId,
      selectedLocationIds: [],
      enabled: true,
    });
    return Response.json({ channel }, { status: 201, headers: noStore });
  } catch (error) {
    console.error("Output channel could not be created", error);
    return Response.json({ detail: "Output channel could not be created" }, { status: 503 });
  }
}

/** Update a channel, including which locations it publishes; its locations.json is rewritten. */
export async function PATCH(request: Request) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!isRecord(body)) return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
    const { id, name, url, enabled, selectedLocationIds } = body;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
      return Response.json({ detail: "Select a valid output channel" }, { status: 422 });
    }
    if (!validName(name)) return Response.json({ detail: "Enter a channel name of up to 120 characters" }, { status: 422 });
    if (!validUrl(url)) return Response.json({ detail: "Enter a valid HTTP or HTTPS channel URL without credentials" }, { status: 422 });
    if (typeof enabled !== "boolean") return Response.json({ detail: "Channel enabled status must be true or false" }, { status: 422 });
    if (!Array.isArray(selectedLocationIds) || selectedLocationIds.length > 1000 ||
      selectedLocationIds.some((locationId) => typeof locationId !== "string" || !locationId || locationId.length > 256) ||
      new Set(selectedLocationIds).size !== selectedLocationIds.length) {
      return Response.json({ detail: "Select a valid list of unique locations" }, { status: 422 });
    }
    const previous = (await listOutputChannels()).find((channel) => channel.id === id);
    if (!previous) return Response.json({ detail: "Output channel was not found" }, { status: 404 });
    const deps = await pipelineDeps();
    const onboarded = new Set((await listLocations(deps.db)).map((location) => location.id));
    if (selectedLocationIds.some((locationId) => !onboarded.has(locationId))) {
      return Response.json({ detail: "One or more selected locations are no longer onboarded; reload the page" }, { status: 422 });
    }
    const channel = await updateOutputChannel(id, {
      name: name.trim(),
      url: new URL(url).toString().replace(/\/$/, ""),
      selectedLocationIds: selectedLocationIds as string[],
      enabled,
    });
    const wasSelected = new Set(previous.selectedLocationIds ?? []);
    const added = (selectedLocationIds as string[]).filter((locationId) => !wasSelected.has(locationId));
    const authoring = { db: deps.db, model: deps.model, settings: deps.settings, log: logger("output-channel") };
    await addLocationsToChannel(deps.db, deps.store, id, added, (locationId) => latestPublished(authoring, locationId));
    return Response.json({ channel }, { headers: noStore });
  } catch (error) {
    console.error("Output channel could not be saved", error);
    return Response.json({ detail: "Output channel could not be saved" }, { status: 503 });
  }
}
