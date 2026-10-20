import { headers } from "next/headers";
import { auth, isAdminEmail } from "@/auth";

export const LOCAL_ADMIN = "local-admin@localhost";

function isLocalHost(host: string | null) {
  const name = (host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

/** Local development skips Google sign-in, but only in local mode, off Vercel, on localhost. */
export async function localAdminAllowed() {
  if ((process.env.NEWSBEE_MODE ?? "local") !== "local" || process.env.VERCEL) return false;
  return isLocalHost((await headers()).get("host"));
}

/** The signed-in admin's email, or null. */
export async function currentAdmin(): Promise<string | null> {
  if (await localAdminAllowed()) return LOCAL_ADMIN;
  const session = await auth();
  const email = session?.user?.email;
  return email && (await isAdminEmail(email)) ? email : null;
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
