import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  // Overwrite client input; guards use only the actual requested path.
  headers.set("x-newsbee-return-to", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!api/|_next/|favicon.ico).*)"],
};
