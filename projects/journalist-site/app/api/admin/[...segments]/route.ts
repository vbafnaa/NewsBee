import { auth, isAdminEmail } from "@/auth";
import type { NextRequest } from "next/server";

type RouteContext = { params: Promise<{ segments: string[] }> };

async function proxy(request: NextRequest, context: RouteContext) {
  const session = await auth();
  if (!(await isAdminEmail(session?.user?.email))) {
    return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
  }
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 });
  }
  const backend = process.env.BACKEND_API_URL?.replace(/\/+$/, "");
  const token = process.env.ADMIN_API_TOKEN;
  if (!backend || !token) {
    return Response.json({ detail: "Admin backend is not configured" }, { status: 503 });
  }
  const { segments } = await context.params;
  const path = segments.map(encodeURIComponent).join("/");
  const target = new URL(`${backend}/api/admin/${path}`);
  target.search = new URL(request.url).search;
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
  const upstream = await fetch(target, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": request.headers.get("content-type") ?? "application/json" } : {}),
    },
    body,
    cache: "no-store",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
