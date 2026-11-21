import { getMongoDatabase } from "@/auth";
import { sameOrigin } from "@/lib/admin-session";
import { PasswordAuthError, passwordResetDetails, resetPassword } from "@/pipeline/accounts/password-auth";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  if (!sameOrigin(request)) return Response.json({ detail: "Cross-origin password requests are not allowed" }, { status: 403, headers });
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new PasswordAuthError("Recovery details are required", 400);
    const input = body as Record<string, unknown>;
    if (typeof input.token !== "string") throw new PasswordAuthError("Recovery link is required", 400);
    const db = await getMongoDatabase();
    if (input.action === "inspect") {
      return Response.json(await passwordResetDetails(db, input.token, request), { headers });
    }
    if (typeof input.password !== "string" || (input.username !== undefined && typeof input.username !== "string")) {
      throw new PasswordAuthError("Complete the password fields", 400);
    }
    const account = await resetPassword(db, {
      token: input.token, password: input.password, username: input.username,
    }, request);
    return Response.json({ account }, { headers });
  } catch (error) {
    const status = error instanceof PasswordAuthError ? error.status : error instanceof SyntaxError ? 400 : 503;
    const detail = error instanceof PasswordAuthError ? error.message
      : error instanceof SyntaxError ? "Request body must be valid JSON" : "Password recovery is temporarily unavailable";
    return Response.json({ detail }, { status, headers });
  }
}
