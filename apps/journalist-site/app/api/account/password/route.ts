import { auth, getMongoDatabase } from "@/auth";
import { currentPrincipal, signedInGuard } from "@/lib/admin-session";
import { changePassword, PasswordAuthError } from "@/pipeline/accounts/password-auth";
import type { Account } from "@/pipeline/accounts/identity";

export async function GET(request: Request) {
  const denied = await signedInGuard(request);
  if (denied) return denied;
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const principal = await currentPrincipal();
    const session = await auth();
    if (!principal || session?.user?.newsbeePrincipalId !== principal.id) {
      throw new PasswordAuthError("Sign in before changing your password; demo identities cannot change credentials", 401);
    }
    const account = await (await getMongoDatabase()).collection<Account>("journalist_admins")
      .findOne({ principalId: principal.id, enabled: true }, { projection: { username: 1, passwordHash: 1 } });
    if (!account) throw new PasswordAuthError("Sign in again before changing your password", 401);
    return Response.json({ username: account.username ?? null, credentialsSet: Boolean(account.passwordHash) }, { headers });
  } catch (error) {
    return Response.json({
      detail: error instanceof PasswordAuthError ? error.message : "Password details could not be loaded",
    }, { status: error instanceof PasswordAuthError ? error.status : 503, headers });
  }
}

export async function POST(request: Request) {
  const denied = await signedInGuard(request);
  if (denied) return denied;
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const principal = await currentPrincipal();
    const session = await auth();
    if (!principal || session?.user?.newsbeePrincipalId !== principal.id) {
      throw new PasswordAuthError("Sign in before changing your password; demo identities cannot change credentials", 401);
    }
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new PasswordAuthError("Password details are required", 400);
    const input = body as Record<string, unknown>;
    if (typeof input.password !== "string" || typeof input.currentPassword !== "string"
      || (input.username !== undefined && typeof input.username !== "string")) {
      throw new PasswordAuthError("Complete the password fields", 400);
    }
    await changePassword(await getMongoDatabase(), principal, session.user.newsbeeSessionVersion ?? 0, {
      currentPassword: input.currentPassword, password: input.password, username: input.username,
    }, request);
    return Response.json({ changed: true }, { headers });
  } catch (error) {
    const status = error instanceof PasswordAuthError ? error.status : error instanceof SyntaxError ? 400 : 503;
    const detail = error instanceof PasswordAuthError ? error.message
      : error instanceof SyntaxError ? "Request body must be valid JSON" : "Password could not be changed";
    return Response.json({ detail }, { status, headers });
  }
}
