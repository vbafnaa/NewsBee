import { getMongoDatabase } from "@/auth";
import { sameOrigin } from "@/lib/admin-session";
import {
  acceptInvitation,
  invitationDetails,
  PasswordAuthError,
} from "@/pipeline/accounts/password-auth";

function responseFor(error: unknown) {
  if (error instanceof PasswordAuthError) {
    return Response.json({ detail: error.message }, { status: error.status });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ detail: "Request body must be valid JSON" }, { status: 400 });
  }
  return Response.json({ detail: "Editor signup is temporarily unavailable" }, { status: 503 });
}

export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    return Response.json(await invitationDetails(await getMongoDatabase(), token), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return responseFor(error);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return Response.json({ detail: "Cross-origin signup requests are not allowed" }, { status: 403 });
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new PasswordAuthError("Signup details are required", 400);
    }
    const input = body as Record<string, unknown>;
    if (
      typeof input.token !== "string"
      || typeof input.email !== "string"
      || typeof input.username !== "string"
      || typeof input.password !== "string"
    ) {
      throw new PasswordAuthError("Complete every signup field", 400);
    }
    const account = await acceptInvitation(await getMongoDatabase(), {
      token: input.token,
      email: input.email,
      username: input.username,
      password: input.password,
    });
    return Response.json({ account }, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return responseFor(error);
  }
}
