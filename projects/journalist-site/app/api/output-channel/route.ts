import {
  auth,
  createOutputChannel,
  getOutputChannel,
  isAdminEmail,
  listOutputChannels,
  listConfiguredSources,
  updateOutputChannel,
} from "@/auth";
import { createOutputChannelFolder } from "@/data-gathering-pipeline/drive";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function authorized() {
  const session = await auth();
  return isAdminEmail(session?.user?.email);
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

export async function GET() {
  try {
    if (!(await authorized())) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    const channels = await listOutputChannels();
    const channel = channels.find((item) => item.id === "reader-site") ?? await getOutputChannel();
    return Response.json({ channel, channels }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Output channels could not be loaded", error);
    return Response.json({ detail: "Output channels could not be loaded" }, { status: 503 });
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
    if (!isRecord(body)) {
      return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
    }
    const { id, name, url } = body;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
      return Response.json({ detail: "Channel ID must be a lowercase slug with 2–64 letters, numbers, or hyphens" }, { status: 422 });
    }
    if (!validName(name)) {
      return Response.json({ detail: "Enter a channel name of up to 120 characters" }, { status: 422 });
    }
    if (!validUrl(url)) {
      return Response.json({ detail: "Enter a valid HTTP or HTTPS channel URL without credentials" }, { status: 422 });
    }
    const channels = await listOutputChannels();
    if (channels.some((channel) => channel.id === id)) {
      return Response.json({ detail: "An output channel with this ID already exists" }, { status: 409 });
    }
    const driveFolderId = await createOutputChannelFolder(id);
    const channel = await createOutputChannel({
      id,
      name: name.trim(),
      url: new URL(url).toString().replace(/\/$/, ""),
      driveFolderId,
      selectedSourceIds: [],
      enabled: true,
    });
    return Response.json({ channel }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Output channel could not be created", error);
    return Response.json({ detail: "Output channel could not be created" }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 });
  }
  try {
    if (!(await authorized())) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    const body: unknown = await request.json().catch(() => null);
    if (!isRecord(body)) {
      return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
    }
    const { id, name, url, enabled, selectedSourceIds } = body;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
      return Response.json({ detail: "Select a valid output channel" }, { status: 422 });
    }
    if (!validName(name)) {
      return Response.json({ detail: "Enter a channel name of up to 120 characters" }, { status: 422 });
    }
    if (!validUrl(url)) {
      return Response.json({ detail: "Enter a valid HTTP or HTTPS channel URL without credentials" }, { status: 422 });
    }
    if (typeof enabled !== "boolean") {
      return Response.json({ detail: "Channel enabled status must be true or false" }, { status: 422 });
    }
    if (!Array.isArray(selectedSourceIds) || selectedSourceIds.length > 100 ||
      selectedSourceIds.some((sourceId) => typeof sourceId !== "string" || !sourceId || sourceId.length > 256) ||
      new Set(selectedSourceIds).size !== selectedSourceIds.length) {
      return Response.json({ detail: "Select a valid list of unique source identifiers" }, { status: 422 });
    }
    const existing = (await listOutputChannels()).find((channel) => channel.id === id);
    if (!existing) return Response.json({ detail: "Output channel was not found" }, { status: 404 });
    const availableSources = new Set((await listConfiguredSources()).map((source) => source.id));
    if (selectedSourceIds.some((sourceId) => !availableSources.has(sourceId))) {
      return Response.json({ detail: "One or more selected sources no longer exist; reload the page" }, { status: 422 });
    }
    const channel = await updateOutputChannel(id, {
      name: name.trim(),
      url: new URL(url).toString().replace(/\/$/, ""),
      selectedSourceIds,
      enabled,
    });
    return Response.json({ channel }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Output channel could not be saved", error);
    return Response.json({ detail: "Output channel could not be saved" }, { status: 503 });
  }
}
