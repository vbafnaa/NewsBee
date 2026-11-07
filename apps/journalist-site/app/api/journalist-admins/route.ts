import { ownerGuard } from "@/lib/admin-session";
import { disableAdminAccount, enableAdminAccount, listAdminAccounts } from "@/auth";
import { ownerEmail } from "@/pipeline/accounts/identity";
import type { NextRequest } from "next/server";

export async function GET(request: Request) {
  const denied = await ownerGuard(request);
  if (denied) return denied;
  return Response.json({ accounts: await listAdminAccounts() }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const denied = await ownerGuard(request);
  if (denied) return denied;

  let body: { email?: unknown; enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ detail: "Request body must be valid JSON" }, { status: 400 });
  }
  if (typeof body.email !== "string") {
    return Response.json({ detail: "Enter a valid email address" }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ detail: "Enter a valid email address" }, { status: 400 });
  }

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return Response.json({ detail: "Invalid enabled flag" }, { status: 400 });
  if (body.enabled === false && email === ownerEmail()) return Response.json({ detail: "The configured owner cannot be disabled" }, { status: 403 });
  const account = body.enabled === false ? await disableAdminAccount(email) : await enableAdminAccount(email);
  return Response.json({ account }, { status: 201 });
}
