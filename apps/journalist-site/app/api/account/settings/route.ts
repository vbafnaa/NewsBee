import { getMongoDatabase } from "@/auth";
import { adminGuard, currentPrincipal } from "@/lib/admin-session";
import { CredentialValidationError, effectiveCredentialProfile, revokeCredentialProfile, saveCredentialProfile, type CredentialInput } from "@/pipeline/accounts/credentials";
import { profileMetadata } from "@/pipeline/accounts/execution";
import { ownerEmail } from "@/pipeline/accounts/identity";
import { logger } from "@/pipeline/core/log";
import { safeError } from "@/pipeline/core/redaction";

export const dynamic = "force-dynamic";
async function handle(request: Request) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  const principal = await currentPrincipal();
  if (!principal) return Response.json({ detail: "Sign in required" }, { status: 401 });
  try {
    const db = await getMongoDatabase();
    if (request.method === "PUT") {
      let input: CredentialInput;
      try { input = await request.json(); } catch { return Response.json({ detail: "Invalid JSON" }, { status: 400 }); }
      if (input?.source === "environment" && principal.role !== "owner") return Response.json({ detail: "Owner access required" }, { status: 403 });
      await saveCredentialProfile(db, principal, input);
    }
    if (request.method === "DELETE") await revokeCredentialProfile(db, principal);
    return Response.json({ principal, ownerConfigured: Boolean(ownerEmail()), profile: profileMetadata(principal, await effectiveCredentialProfile(db, principal)) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!(error instanceof CredentialValidationError)) logger("account-settings").error("settings_unavailable", { error: safeError(error) });
    return Response.json({ detail: error instanceof CredentialValidationError ? error.message : "Account settings are unavailable; check server credential provisioning" }, { status: error instanceof CredentialValidationError ? 400 : 503 });
  }
}
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;
