import { auth, getOutputChannel, isAdminEmail, updateOutputChannel } from "@/auth";
import type { NextRequest } from "next/server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function authorized() {
  const session = await auth();
  return isAdminEmail(session?.user?.email);
}

export async function GET() {
  try {
    if (!(await authorized())) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    return Response.json(
      { channel: await getOutputChannel() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Output channel could not be loaded", error);
    return Response.json({ detail: "Output channel could not be loaded" }, { status: 503 });
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
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ detail: "Request body must be valid JSON" }, { status: 400 });
    }
    if (!isRecord(body)) {
      return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
    }
    const { name, url, driveFolderId, enabled } = body;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
      return Response.json({ detail: "Enter a channel name of up to 120 characters" }, { status: 422 });
    }
    if (typeof url !== "string" || url.length > 2048) {
      return Response.json({ detail: "Enter a valid channel URL" }, { status: 422 });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return Response.json({ detail: "Enter a valid channel URL" }, { status: 422 });
    }
    if (!["https:", "http:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      return Response.json({ detail: "Channel URL must use HTTP or HTTPS and cannot include credentials" }, { status: 422 });
    }
    if (typeof driveFolderId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(driveFolderId)) {
      return Response.json({ detail: "Enter a valid Google Drive folder ID" }, { status: 422 });
    }
    if (typeof enabled !== "boolean") {
      return Response.json({ detail: "Channel enabled status must be true or false" }, { status: 422 });
    }

    const channel = await updateOutputChannel({
      name: name.trim(),
      url: parsedUrl.toString().replace(/\/$/, ""),
      driveFolderId,
      enabled,
    });
    return Response.json({ channel }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Output channel could not be saved", error);
    return Response.json({ detail: "Output channel could not be saved" }, { status: 503 });
  }
}
