import { cookies, headers } from "next/headers";
import { auth, getMongoDatabase } from "@/auth";
import { isOperator, ownerEmail, principalForSession, principalForEmail, type Principal } from "@/pipeline/accounts/identity";
import { maintenanceState } from "../../../shared/restore-maintenance";

export const LOCAL_ADMIN = "local-admin@localhost";
export const LOCAL_ROLE_COOKIE = "newsbee-local-role";

const LOCAL_ROLE_EMAILS = {
  admin: "admin@newsbee.local",
  "editor-a": "editor-a@newsbee.local",
  "editor-b": "editor-b@newsbee.local",
} as const;

function isLocalHost(host: string | null) {
  const name = (host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

/** Local development skips Google sign-in, but only in local mode, off Vercel, on localhost. */
export async function localAdminAllowed() {
  if (process.env.NEWSBEE_MODE !== "local" || process.env.VERCEL || process.env.NODE_ENV === "production") return false;
  return isLocalHost((await headers()).get("host"));
}

/** The signed-in admin's email, or null. */
export async function currentAdmin(): Promise<string | null> {
  return (await currentPrincipal())?.email ?? null;
}

/** Bind destructive restore to the signed generation, never a later database generation. */
export async function currentRestoreGeneration() {
  if (await localAdminAllowed()) return (await maintenanceState(await getMongoDatabase())).identityGeneration;
  return (await auth())?.user?.newsbeeRestoreGeneration ?? "0";
}

export async function currentPrincipal(): Promise<Principal | null> {
  if (await localAdminAllowed()) {
    const selected = (await cookies()).get(LOCAL_ROLE_COOKIE)?.value;
    if (selected) {
      if (selected === "owner") {
        return { id: "local-admin", email: ownerEmail() || LOCAL_ADMIN, role: "owner" };
      }
      const email = LOCAL_ROLE_EMAILS[selected as keyof typeof LOCAL_ROLE_EMAILS];
      return email ? principalForEmail(await getMongoDatabase(), email) : null;
    }
    if (process.env.NEWSBEE_LOCAL_PRINCIPAL_ROLE === "editor") {
      return {
        id: process.env.NEWSBEE_LOCAL_PRINCIPAL_ID?.trim() || "local-editor",
        email: process.env.NEWSBEE_LOCAL_PRINCIPAL_EMAIL?.trim() || "local-editor@localhost",
        role: "editor",
      };
    }
    return { id: "local-admin", email: ownerEmail() || LOCAL_ADMIN, role: "owner" };
  }
  const session = await auth();
  const principalId = session?.user?.newsbeePrincipalId;
  return typeof principalId === "string" && principalId
    ? principalForSession(await getMongoDatabase(), principalId, session?.user?.newsbeeSessionVersion, session?.user?.newsbeeRestoreGeneration) : null;
}

export async function ownerGuard(request: Request): Promise<Response | null> {
  const denied = await operatorGuard(request);
  if (denied) return denied;
  return (await currentPrincipal())?.role === "owner" ? null
    : Response.json({ detail: "Owner access required" }, { status: 403 });
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    return new URL(origin).host === (host ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

/** For API routes: an error response when not an owner/admin operator, else null. */
export async function signedInGuard(request: Request): Promise<Response | null> {
  const principal = await currentPrincipal();
  if (!principal) {
    return Response.json({ detail: "Sign in as an authorized Newsbee user" }, { status: 401 });
  }
  if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request)) {
    return Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 });
  }
  return null;
}

/** For API routes: an error response when not an owner/admin operator, else null. */
export async function operatorGuard(request: Request): Promise<Response | null> {
  const principal = await currentPrincipal();
  if (!principal) {
    return Response.json({ detail: "Sign in as an authorized Newsbee user" }, { status: 401 });
  }
  if (!isOperator(principal)) {
    return Response.json({ detail: "Newsbee operator access required" }, { status: 403 });
  }
  if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request)) {
    return Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 });
  }
  return null;
}

/** Compatibility alias for existing operator routes. */
export const adminGuard = operatorGuard;
