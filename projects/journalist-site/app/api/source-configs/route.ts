import { currentAdmin, sameOrigin } from "@/lib/admin-session";
import {
  createConfiguredSource,
  deleteConfiguredSource,
  listConfiguredSources,
  SourceConfigError,
  updateConfiguredSource,
} from "@/auth";
import type { SourceConfigInput } from "@/auth";
import type { NextRequest } from "next/server";

async function authorized() {
  return Boolean(await currentAdmin());
}

function validUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validConfigKey(value: unknown, maxLength: number) {
  return typeof value === "string" &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) &&
    !["__proto__", "constructor", "prototype"].includes(value);
}

function parseSource(value: unknown, requireIdentity: boolean): SourceConfigInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.kind !== "library" && body.kind !== "government" && body.kind !== "state-newsroom") return null;
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) return null;

  const source: SourceConfigInput = { kind: body.kind, name: body.name.trim() };
  if (body.kind === "library") {
    if (requireIdentity && !validConfigKey(body.location, 64)) return null;
    if (!validUrl(body.url)) return null;
    return { ...source, location: typeof body.location === "string" ? body.location : undefined, url: body.url };
  }
  if (body.kind === "government") {
    if (requireIdentity && !validConfigKey(body.location, 64)) return null;
    if (body.platform !== "legistar" && body.platform !== "civicclerk") return null;
    if (typeof body.tenant !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.tenant.trim())) return null;
    return {
      ...source,
      location: typeof body.location === "string" ? body.location : undefined,
      platform: body.platform,
      tenant: body.tenant.trim(),
    };
  }

  if (requireIdentity && !validConfigKey(body.region, 20)) return null;
  if (!validUrl(body.url)) return null;
  return { ...source, region: typeof body.region === "string" ? body.region : undefined, url: body.url };
}

async function mutationAllowed(request: NextRequest) {
  if (!(await authorized())) {
    return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
  }
  if (!sameOrigin(request)) {
    return Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 });
  }
  return null;
}

async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new SourceConfigError("Request body must be valid JSON.");
  }
}

function responseForSourceError(error: unknown) {
  if (error instanceof SourceConfigError) {
    return Response.json({ detail: error.message }, { status: error.status });
  }
  throw error;
}

export async function GET() {
  if (!(await authorized())) {
    return Response.json(
      { detail: "Sign in as an authorized administrator" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const sources = await listConfiguredSources();
  return Response.json({ sources }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const denied = await mutationAllowed(request);
  if (denied) return denied;

  let source: SourceConfigInput | null;
  try {
    source = parseSource(await readJson(request), true);
  } catch (error) {
    return responseForSourceError(error);
  }
  if (!source) return Response.json({ detail: "Source details are invalid." }, { status: 400 });

  try {
    await createConfiguredSource(source);
    return Response.json({ success: true }, { status: 201 });
  } catch (error) {
    return responseForSourceError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const denied = await mutationAllowed(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    return responseForSourceError(error);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ detail: "Request body must be a JSON object." }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  if (typeof payload.id !== "string" || !payload.id || payload.id.length > 256) {
    return Response.json({ detail: "Source identifier is invalid." }, { status: 400 });
  }
  const source = parseSource(payload, false);
  if (!source) return Response.json({ detail: "Source details are invalid." }, { status: 400 });

  try {
    await updateConfiguredSource(payload.id, source);
    return Response.json({ success: true });
  } catch (error) {
    return responseForSourceError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const denied = await mutationAllowed(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    return responseForSourceError(error);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ detail: "Request body must be a JSON object." }, { status: 400 });
  }

  const id = (body as Record<string, unknown>).id;
  if (typeof id !== "string" || !id || id.length > 256) {
    return Response.json({ detail: "Source identifier is invalid." }, { status: 400 });
  }
  try {
    await deleteConfiguredSource(id);
    return Response.json({ success: true });
  } catch (error) {
    return responseForSourceError(error);
  }
}
