import { auth, enableAdminAccount, isAdminEmail, listAdminAccounts } from "@/auth";
import type { NextRequest } from "next/server";

async function authorized() {
  const session = await auth();
  return isAdminEmail(session?.user?.email);
}

export async function GET() {
  if (!(await authorized())) {
    return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
  }
  return Response.json({ accounts: await listAdminAccounts() });
}

export async function POST(request: NextRequest) {
  if (!(await authorized())) {
    return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 });
  }

  let body: { email?: unknown };
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

  const account = await enableAdminAccount(email);
  return Response.json({ account }, { status: 201 });
}
