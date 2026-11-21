import { NextResponse, type NextRequest } from "next/server";
import { LOCAL_ROLE_COOKIE, localAdminAllowed } from "@/lib/admin-session";

const roles = new Set(["owner", "admin", "editor-a", "editor-b"]);

export async function GET(request: NextRequest) {
  if (!(await localAdminAllowed())) {
    return Response.json({ detail: "Local role switching is unavailable" }, { status: 404 });
  }
  const selected = request.nextUrl.searchParams.get("as") ?? "";
  if (!roles.has(selected)) {
    return Response.json({ detail: "Choose owner, admin, editor-a or editor-b" }, { status: 400 });
  }
  const requested = request.nextUrl.searchParams.get("returnTo") ?? "";
  const returnTo = requested.startsWith("/") && !requested.startsWith("//")
    ? requested
    : selected === "editor-a" || selected === "editor-b" ? "/newsroom" : "/admin";
  const response = NextResponse.redirect(new URL(returnTo, request.url));
  response.cookies.set(LOCAL_ROLE_COOKIE, selected, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return response;
}
