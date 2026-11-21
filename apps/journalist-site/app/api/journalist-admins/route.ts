export async function GET(request: Request) {
  return Response.redirect(new URL("/api/admin/access", request.url), 308);
}

export async function POST() {
  return Response.json({
    detail: "This compatibility endpoint is read-only. Use /admin/access so revision checks and audit logging are enforced.",
  }, { status: 410 });
}
