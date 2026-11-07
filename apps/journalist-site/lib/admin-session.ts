import { headers } from "next/headers";
import { auth, getMongoDatabase } from "@/auth";
import { principalForEmail, type Principal } from "@/pipeline/accounts/identity";

export const LOCAL_ADMIN = "local-admin@localhost";

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

export async function currentPrincipal(): Promise<Principal | null> {
  if (await localAdminAllowed()) return { id: "local-admin", email: LOCAL_ADMIN, role: "owner" };
  const session = await auth();
  const email = session?.user?.email;
  return email ? principalForEmail(await getMongoDatabase(), email) : null;
}

export async function ownerGuard(request: Request): Promise<Response | null> {
  const denied = await adminGuard(request);
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

/** For API routes: an error response when not an admin (or a cross-origin write), else null. */
export async function adminGuard(request: Request): Promise<Response | null> {
  if (!(await currentAdmin())) {
    return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
  }
  if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request)) {
    return Response.json({ detail: "Cross-origin admin requests are not allowed" }, { status: 403 });
  }
  return null;
}
