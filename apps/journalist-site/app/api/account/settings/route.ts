import { getMongoDatabase } from "@/auth";
import { currentPrincipal, operatorGuard } from "@/lib/admin-session";
import { CredentialValidationError, credentialProfile, effectiveCredentialProfile, revokeCredentialProfile, saveCredentialProfile, type CredentialInput } from "@/pipeline/accounts/credentials";
import { deploymentCredentialDefaults, profileMetadata } from "@/pipeline/accounts/execution";
import { isConfiguredOwner, ownerEmail } from "@/pipeline/accounts/identity";
import { logger } from "@/pipeline/core/log";
import { safeError } from "@/pipeline/core/redaction";

export const dynamic = "force-dynamic";
async function handle(request: Request) {
  const denied = await operatorGuard(request);
  if (denied) return denied;
  const principal = await currentPrincipal();
  if (!principal) return Response.json({ detail: "Sign in required" }, { status: 401 });
  try {
    const db = await getMongoDatabase();
    const owner = isConfiguredOwner(principal);
    if (request.method === "PUT") {
      let input: CredentialInput;
      try { input = await request.json(); } catch { return Response.json({ detail: "Invalid JSON" }, { status: 400 }); }
      if (!owner && input.source !== "personal") {
        throw new CredentialValidationError("Team admins may save only personal API settings.");
      }
      await saveCredentialProfile(db, principal, input);
    }
    if (request.method === "DELETE") await revokeCredentialProfile(db, principal);
    const storedProfile = owner ? null : await credentialProfile(db, principal);
    const profile = owner
      ? await effectiveCredentialProfile(db, principal)
      : storedProfile?.source === "personal" ? storedProfile : null;
    return Response.json({
      principal,
      profile: profileMetadata(principal, profile),
      ...(owner ? {
        ownerConfigured: Boolean(ownerEmail()),
        environmentDefaults: deploymentCredentialDefaults(),
      } : {}),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!(error instanceof CredentialValidationError)) logger("account-settings").error("settings_unavailable", { error: safeError(error) });
    return Response.json({ detail: error instanceof CredentialValidationError ? error.message : "Account settings are unavailable; check server credential provisioning" }, { status: error instanceof CredentialValidationError ? 400 : 503 });
  }
}
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;
