import { randomUUID } from "node:crypto";
import { adminRoute, jsonBody } from "@/lib/admin-api";
import { listLocations } from "@/pipeline/communities/locations";
import { logger } from "@/pipeline/core/log";
import { COLLECTIONS } from "@/pipeline/storage/mongo";
import {
  channelFolder,
  clearOutputChannelEditions,
  clearOutputChannelFeed,
  createOutputChannel,
  getOutputChannel,
  listOutputChannels,
  outputChannels,
  updateOutputChannel,
  writeOutputChannelDirectory,
  type OutputChannelInput,
  type OutputDestination,
} from "@/pipeline/orchestration/output-channels";
import { createUserDriveChannelFolder, hasGoogleDriveAuthorization } from "@/pipeline/storage/user-drive";
import { channelArtifactStore, driveChannelFolderOrMongo } from "@/pipeline/storage/mongo-channel-artifacts";
import { isMongoChannelFolderId } from "../../../../../../shared/reader-folder";

type ChannelBody = { id?: unknown; name?: unknown; url?: unknown; destination?: unknown; destinations?: unknown; enabled?: unknown; selectedLocationIds?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function input(body: ChannelBody): OutputChannelInput | null {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) return null;
  const normalizeUrl = (value: unknown) => {
    const urlValue = typeof value === "string" ? value.trim() : "";
    if (urlValue.length > 2048) return null;
    if (!urlValue) return "";
    try {
      const url = new URL(urlValue);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
      return url.toString().replace(/\/$/, "");
    } catch { return null; }
  };
  let destinations: OutputDestination[];
  if (body.destinations !== undefined && !Array.isArray(body.destinations)) return null;
  if (Array.isArray(body.destinations)) {
    if (body.destinations.length < 1 || body.destinations.length > 2) return null;
    destinations = [];
    for (const item of body.destinations) {
      if (!isRecord(item) || (item.type !== "reader" && item.type !== "video")) return null;
      const url = normalizeUrl(item.url);
      if (url === null || destinations.some((destination) => destination.type === item.type)) return null;
      destinations.push({ type: item.type, url });
    }
  } else {
    const destination = body.destination ?? "reader";
    if (destination !== "reader" && destination !== "video") return null;
    const url = normalizeUrl(body.url);
    if (url === null) return null;
    destinations = [{ type: destination, url }];
  }
  if (typeof body.enabled !== "boolean" || !Array.isArray(body.selectedLocationIds) ||
    body.selectedLocationIds.length > 1000 ||
    body.selectedLocationIds.some((id) => typeof id !== "string" || !id || id.length > 256) ||
    new Set(body.selectedLocationIds).size !== body.selectedLocationIds.length) return null;
  return {
    name: body.name.trim(),
    destinations,
    enabled: body.enabled,
    selectedLocationIds: body.selectedLocationIds as string[],
  };
}

function isReaderDestination(destinations: OutputDestination[]) {
  return destinations.some((destination) => destination.type === "reader");
}

async function validateLocations(db: Parameters<typeof listLocations>[0], ids: string[]) {
  const onboarded = new Set((await listLocations(db)).map((location) => location.id));
  return ids.every((id) => onboarded.has(id));
}

function ownerId(principal: { id: string } | undefined) {
  if (!principal) throw new Error("Sign in as an approved journalist.");
  return principal.id;
}

export async function GET(request: Request) {
  return adminRoute(request, async ({ db, principal, settings }) => {
    if (!principal) throw new Error("Sign in as an approved journalist.");
    return {
      channels: await listOutputChannels(db, ownerId(principal)),
      locations: (await listLocations(db)).map(({ id, name }) => ({ id, name })),
      requiresGoogleDriveAuthorization: settings.mode === "cloud",
      googleDriveConnected: settings.mode !== "cloud" || await hasGoogleDriveAuthorization(request, principal.email),
    };
  });
}

export async function POST(request: Request) {
  return adminRoute(request, async (deps) => {
    const body: unknown = await jsonBody(request);
    if (!isRecord(body)) return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
    const value = input(body as ChannelBody);
    if (!value) return Response.json({ detail: "Enter a channel name, at least one destination with a valid optional HTTP or HTTPS URL, enabled state, and unique location selections." }, { status: 422 });
    if (!await validateLocations(deps.db, value.selectedLocationIds)) {
      return Response.json({ detail: "One or more selected locations are no longer onboarded; reload the page." }, { status: 422 });
    }
    if (!deps.principal) throw new Error("Sign in as an approved journalist.");
    const email = deps.principal.email;
    const id = randomUUID().replaceAll("-", "");
    let folderId: string;
    if (deps.store.kind === "drive") {
      folderId = await driveChannelFolderOrMongo(
        deps.store, id, await hasGoogleDriveAuthorization(request, email),
                () => createUserDriveChannelFolder(request, email, deps.settings.pipelineDriveFolderId, id),
        (error) => logger("output-channels").warn("channel_drive_unavailable", { error: error instanceof Error ? error.message : String(error) }),
      );
    } else {
      folderId = await channelFolder(deps.store, deps.settings.pipelineDriveFolderId, id);
    }
    const channel = await createOutputChannel(deps.db, ownerId(deps.principal), id, folderId, value);
    const document = await outputChannels(deps.db).findOne({ _id: channel.id, owner_id: ownerId(deps.principal) });
    if (document && isReaderDestination(channel.destinations)) await writeOutputChannelDirectory(deps.db, deps.store, document);
    return Response.json({ channel }, { status: 201 });
  });
}

export async function PATCH(request: Request) {
  return adminRoute(request, async (deps) => {
    const body: unknown = await jsonBody(request);
    if (!isRecord(body)) return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
    if (typeof body.id !== "string" || !/^[a-f0-9]{32}$/.test(body.id)) {
      return Response.json({ detail: "Select a valid output channel." }, { status: 422 });
    }
    const value = input(body as ChannelBody);
    if (!value) return Response.json({ detail: "Enter a channel name, at least one destination with a valid optional HTTP or HTTPS URL, enabled state, and unique location selections." }, { status: 422 });
    if (!await validateLocations(deps.db, value.selectedLocationIds)) {
      return Response.json({ detail: "One or more selected locations are no longer onboarded; reload the page." }, { status: 422 });
    }
    const owner = ownerId(deps.principal);
    const previous = await getOutputChannel(deps.db, owner, body.id);
    if (!previous) return Response.json({ detail: "Output channel was not found." }, { status: 404 });
    const channel = await updateOutputChannel(deps.db, owner, body.id, value);
    if (!channel) return Response.json({ detail: "Output channel was not found." }, { status: 404 });
    const previousHasReader = isReaderDestination(previous.destinations);
    const channelHasReader = isReaderDestination(channel.destinations);
    if (previousHasReader && !channelHasReader) {
      const document = await outputChannels(deps.db).findOne({ _id: channel.id, owner_id: owner });
      if (document) {
        await clearOutputChannelFeed(deps.db, deps.store, document);
        await clearOutputChannelEditions(deps.db, deps.store, document);
      }
    }
    const document = await outputChannels(deps.db).findOne({ _id: channel.id, owner_id: owner });
    if (document && channelHasReader) await writeOutputChannelDirectory(deps.db, deps.store, document);
    return { channel };
  });
}

export async function DELETE(request: Request) {
  return adminRoute(request, async (deps) => {
    const body: unknown = await jsonBody(request);
    if (!isRecord(body) || typeof body.id !== "string" || !/^[a-f0-9]{32}$/.test(body.id)) {
      return Response.json({ detail: "Select a valid output channel." }, { status: 422 });
    }
    const owner = ownerId(deps.principal);
    const channel = await outputChannels(deps.db).findOne({ _id: body.id, owner_id: owner });
    if (!channel) return Response.json({ detail: "Output channel was not found." }, { status: 404 });
    const store = channelArtifactStore(deps.db, deps.store, channel.drive_folder_id);
    for (const locationId of new Set(channel.published_location_ids ?? [])) {
      const editions = await deps.db.collection<{ id: string }>(COLLECTIONS.editions)
        .find({ location_id: locationId, id: { $exists: true } }).project<{ id: string }>({ id: 1 }).toArray();
      for (const edition of editions) await store.removeFile(channel.drive_folder_id, `${edition.id}.json`);
    }
    await store.removeFile(channel.drive_folder_id, "locations.json");
    await clearOutputChannelEditions(deps.db, deps.store, channel);
    if (isMongoChannelFolderId(channel.drive_folder_id)) {
      await deps.db.collection(COLLECTIONS.outputChannelFiles).deleteMany({ folder_id: channel.drive_folder_id });
    }
    await outputChannels(deps.db).deleteOne({ _id: body.id, owner_id: owner });
    return { deleted: body.id };
  });
}
