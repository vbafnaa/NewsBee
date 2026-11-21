import { jsonBody, publicationRoute } from "@/lib/admin-api";
import { AccessPolicyError } from "@/pipeline/accounts/access-policy";
import { setPublicationArchived } from "@/pipeline/publications/archive";
import { listLocations } from "@/pipeline/communities/locations";
import { locationReadinessForIds } from "@/pipeline/communities/readiness";
import { logger } from "@/pipeline/core/log";
import { assertPublicationWrite, authorizedPublicationFilter, publicationAccessFilter } from "@/pipeline/publications/access";
import { appendPublicationChangeAudit } from "@/pipeline/publications/audit";
import { PublicationLifecycleConflict } from "@/pipeline/publications/lifecycle";
import {
  clearOutputChannelEditions,
  clearOutputChannelFeed,
  listOutputChannelDirectory,
  outputChannels,
  outputChannelConfigurationHash as configurationHash,
  resolveOutputChannelForPrincipal,
  updateOutputChannel,
  writeOutputChannelDirectory,
  type OutputChannelInput,
  type OutputDestination,
} from "@/pipeline/orchestration/output-channels";
import { hasGoogleDriveAuthorization, provisionUserDriveChannelFolder, reserveUserDriveFolderId } from "@/pipeline/storage/user-drive";
import { mongoChannelFolderId } from "../../../../../../shared/reader-folder";
import { activePublicationSupport } from "@/pipeline/publications/support";
import { createNewsroom, NewsroomCreationConflict, NewsroomCreationInvalid } from "@/pipeline/orchestration/create-newsroom";

type ChannelBody = { id?: unknown; name?: unknown; url?: unknown; destination?: unknown; destinations?: unknown; enabled?: unknown; selectedLocationIds?: unknown; allowedLocationIds?: unknown; lifecycleRevision?: unknown };

const MAX_LOCATIONS = 1000;
function locationIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_LOCATIONS &&
    value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256) &&
    new Set(value).size === value.length;
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function channelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function conflict() {
  return Response.json({ detail: new PublicationLifecycleConflict().message }, { status: 409 });
}

function sameLocations(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

async function staleRevision(
  db: Parameters<typeof outputChannels>[0], principal: { id: string; role: string }, id: string, expected: number,
) {
  const channel = await outputChannels(db).findOne({
    _id: id,
    ...(principal.role === "owner" || principal.role === "admin" ? {} : publicationAccessFilter(principal.id)),
  });
  return channel && (channel.lifecycle_revision ?? 0) !== expected;
}

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
  if (typeof body.enabled !== "boolean" || !locationIds(body.selectedLocationIds)) return null;
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
  if (!ids.length) return true;
  const ready = new Set((await locationReadinessForIds(db, ids.map((id) => ({ id, name: id }))))
    .filter((location) => location.state === "ready").map((location) => location.location_id));
  return ids.every((id) => ready.has(id));
}

export async function GET(request: Request) {
  return publicationRoute(request, async ({ db, principal, settings }) => {
    if (!principal) throw new Error("Sign in as an approved journalist.");
    const locations = await listLocations(db);
    const readiness = new Map((await locationReadinessForIds(db, locations)).map((row) => [row.location_id, row]));
    const channelId = new URL(request.url).searchParams.get("channelId");
    const access = channelId ? await resolveOutputChannelForPrincipal(db, principal, channelId, "Open newsroom coverage and destinations") : null;
    if (channelId && !access) return Response.json({ detail: "Newsroom not found." }, { status: 404 });
    const support = access?.context.role === "privileged" ? await activePublicationSupport(db, principal, channelId!) : null;
    return {
      directory: await listOutputChannelDirectory(db, principal),
      channels: access ? [{ ...access.channel,
        accessMode: access.context.role === "privileged" ? support ? "support" : "inspection" : "direct",
        canWrite: access.channel.archivedAt === null && (access.context.role !== "privileged" || Boolean(support)),
        supportExpiresAt: support?.expires_at ?? null,
      }] : [],
      locations: locations.map(({ id, name }) => {
        const row = readiness.get(id);
        return {
          id, name, ready: row?.ready ?? false, preparation_state: row?.state ?? "preparing",
          missing_prerequisites: row?.missing_prerequisites ?? [],
          ...(principal.role !== "editor" && row && "remedy" in row ? { remedy: row.remedy } : {}),
        };
      }),
      canManageAllowedCommunities: principal.role === "owner" || principal.role === "admin",
      canCreateNewsrooms: principal.role === "owner" || principal.role === "admin",
      requiresGoogleDriveAuthorization: settings.mode === "cloud",
      googleDriveConnected: settings.mode !== "cloud" || await hasGoogleDriveAuthorization(request, principal.email),
    };
  });
}

export async function POST(request: Request) {
  return publicationRoute(request, async (deps) => {
    if (!deps.principal || !["owner", "admin"].includes(deps.principal.role)) {
      return Response.json({ detail: "Only workspace administrators can create newsrooms." }, { status: 403 });
    }
    const body: unknown = await jsonBody(request);
    if (!isRecord(body)) return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
    const value = input(body as ChannelBody);
    if (!value) return Response.json({ detail: "Enter a channel name, at least one destination with a valid optional HTTP or HTTPS URL, enabled state, and unique location selections." }, { status: 422 });
    if (!deps.principal) throw new Error("Sign in as an approved journalist.");
    if (typeof body.requestKey !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.requestKey)) {
      return Response.json({ detail: "A stable newsroom creation request key is required." }, { status: 422 });
    }
    if (body.allowedLocationIds !== undefined) {
      return Response.json({ detail: "A new publication's allowed communities are exactly its initial selected communities." }, { status: 422 });
    }
    const email = deps.principal.email;
    try {
      const channel = await createNewsroom(deps.db, deps.principal, body.requestKey, value, {
        validate: async () => {
          if (!await validateLocations(deps.db, value.selectedLocationIds)) throw new NewsroomCreationInvalid("Select only communities that are currently Ready.");
          if (await outputChannels(deps.db).countDocuments({ owner_id: deps.principal!.id }) >= 100) {
            throw new NewsroomCreationInvalid("Newsroom limit reached. Contact a workspace administrator.");
          }
        },
        planFolder: async (id) => {
          if (deps.store.kind !== "drive") return { id: `channel-${id}`, drive: false };
          if (await hasGoogleDriveAuthorization(request, email)) {
            try { return { id: await reserveUserDriveFolderId(request, email), drive: true }; }
            catch (error) {
              logger("output-channels").warn("channel_drive_unavailable", { error: error instanceof Error ? error.message : String(error) });
            }
          }
          return { id: mongoChannelFolderId(id), drive: false };
        },
        provision: async (id, folder) => {
          if (folder.drive) await provisionUserDriveChannelFolder(request, email, deps.settings.pipelineDriveFolderId, id, folder.id);
        },
      });
      return Response.json({ channel }, { status: 201 });
    } catch (error) {
      if (error instanceof NewsroomCreationConflict || error instanceof NewsroomCreationInvalid) {
        return Response.json({ detail: error.message }, { status: error instanceof NewsroomCreationConflict ? 409 : 422 });
      }
      throw error;
    }
  });
}

export async function PATCH(request: Request) {
  return publicationRoute(request, async (deps) => {
    const body: unknown = await jsonBody(request);
    if (!isRecord(body)) return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
    if (!channelId(body.id)) {
      return Response.json({ detail: "Select a valid output channel." }, { status: 422 });
    }
    if (!revision(body.lifecycleRevision)) return Response.json({ detail: "A current publication revision is required." }, { status: 422 });
    if (body.action === "restore") {
      try { return { channel: await setPublicationArchived(deps.db, deps.principal!, body.id, body.lifecycleRevision, false) }; }
      catch (error) {
        if (error instanceof AccessPolicyError) return Response.json({ detail: error.message }, { status: error.status });
        throw error;
      }
    }
    if (await staleRevision(deps.db, deps.principal!, body.id, body.lifecycleRevision)) return conflict();
    const value = input(body as ChannelBody);
    if (!value) return Response.json({ detail: "Enter a channel name, at least one destination with a valid optional HTTP or HTTPS URL, enabled state, and unique location selections." }, { status: 422 });
    const access = await resolveOutputChannelForPrincipal(
      deps.db,
      deps.principal!,
      body.id,
      "Update a publication from the support workspace",
      "write",
    );
    if (!access) return Response.json({ detail: "Output channel was not found." }, { status: 404 });
    if (access.channel.lifecycleRevision !== body.lifecycleRevision) return conflict();
    await assertPublicationWrite(deps.db, access.context, "publication_updated", { audit: false });
    let allowed = access.channel.allowedLocationIds;
    if (body.allowedLocationIds !== undefined) {
      if (deps.principal?.role !== "owner" && deps.principal?.role !== "admin") {
        return Response.json({ detail: "Only workspace owners and administrators can change allowed communities." }, { status: 403 });
      }
      if (!locationIds(body.allowedLocationIds)) return Response.json({ detail: "Enter unique allowed communities within the server limit." }, { status: 422 });
      const additions = body.allowedLocationIds.filter((id) => !allowed.includes(id));
      if (!await validateLocations(deps.db, additions)) return Response.json({ detail: "New allowed communities must be Ready." }, { status: 422 });
      allowed = body.allowedLocationIds;
    }
    if (value.selectedLocationIds.some((id) => !allowed.includes(id))) {
      return Response.json({ detail: "Edition coverage must stay within the publication's allowed communities." }, { status: 403 });
    }
    if (!await validateLocations(deps.db, value.selectedLocationIds)) {
      return Response.json({ detail: "Select only communities that are currently Ready." }, { status: 422 });
    }
    const previous = access.channel;
    const previousHasReader = isReaderDestination(previous.destinations);
    const channelHasReader = isReaderDestination(value.destinations);
    if (previousHasReader && !channelHasReader && deps.principal?.role !== "owner") {
      return Response.json({
        detail: "Only the owner can remove the Reader destination because it clears publication artifacts.",
      }, { status: 403 });
    }
    let channel;
    try { channel = await updateOutputChannel(deps.db, access, value, body.lifecycleRevision,
      body.allowedLocationIds === undefined ? undefined : allowed); }
    catch (error) { if (error instanceof PublicationLifecycleConflict) return conflict(); throw error; }
    await appendPublicationChangeAudit(deps.db, {
      publication_id: access.context.id, principal_id: deps.principal!.id, principal_email: deps.principal!.email,
      action: !sameLocations(access.channel.allowedLocationIds, channel.allowedLocationIds)
        ? "allowed_communities_updated"
        : !sameLocations(access.channel.selectedLocationIds, channel.selectedLocationIds)
          ? "coverage_updated" : "publication_updated",
      resource_id: access.context.id, detail: `Updated publication settings at lifecycle revision ${body.lifecycleRevision + 1}.`,
      before_hash: configurationHash(access.channel), after_hash: configurationHash(channel),
    });
    if (previousHasReader && !channelHasReader) {
      const document = await outputChannels(deps.db).findOne(authorizedPublicationFilter(access.context));
      if (document) {
        await clearOutputChannelFeed(deps.db, deps.store, document);
        await clearOutputChannelEditions(deps.db, deps.store, document);
      }
    }
    const document = await outputChannels(deps.db).findOne(authorizedPublicationFilter(access.context));
    if (document && channelHasReader) await writeOutputChannelDirectory(deps.db, deps.store, document);
    return { channel };
  });
}

export async function DELETE(request: Request) {
  return publicationRoute(request, async (deps) => {
    if (!deps.principal || !["owner", "admin"].includes(deps.principal.role)) {
      return Response.json({ detail: "Workspace administrator access required." }, { status: 403 });
    }
    const body: unknown = await jsonBody(request);
    if (!isRecord(body) || !channelId(body.id)) {
      return Response.json({ detail: "Select a valid output channel." }, { status: 422 });
    }
    if (!revision(body.lifecycleRevision)) return Response.json({ detail: "A current publication revision is required." }, { status: 422 });
    try { return { channel: await setPublicationArchived(deps.db, deps.principal, body.id, body.lifecycleRevision, true) }; }
    catch (error) {
      if (error instanceof AccessPolicyError) return Response.json({ detail: error.message }, { status: error.status });
      throw error;
    }
  });
}
