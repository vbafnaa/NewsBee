import { getMongoDatabase } from "@/auth";
import { currentPrincipal, operatorGuard } from "@/lib/admin-session";
import {
  AccessPolicyError,
  createEditorInvitation,
  deleteAccessAccount,
  listAccessPolicy,
  issueAccountPasswordReset,
  renewEditorInvitation,
  updateAccessPolicy,
  type AccessPolicyUpdate,
} from "@/pipeline/accounts/access-policy";
import { PasswordAuthError } from "@/pipeline/accounts/password-auth";
import { MaintenanceError } from "../../../../../../shared/restore-maintenance";

function errorResponse(error: unknown) {
  if (error instanceof AccessPolicyError || error instanceof PasswordAuthError || error instanceof MaintenanceError) {
    return Response.json({ detail: error.message }, {
      status: error.status, headers: { "Cache-Control": "private, no-store" },
    });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ detail: "Request body must be valid JSON" }, { status: 400 });
  }
  return Response.json({ detail: "Access policies could not be updated" }, { status: 500 });
}

async function actor() {
  const principal = await currentPrincipal();
  if (!principal) throw new AccessPolicyError("Sign in as a Newsbee operator", 403);
  return principal;
}

export async function GET(request: Request) {
  const denied = await operatorGuard(request);
  if (denied) return denied;
  try {
    return Response.json(await listAccessPolicy(await getMongoDatabase(), await actor()), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const denied = await operatorGuard(request);
  if (denied) return denied;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AccessPolicyError("Request body must be a JSON object", 400);
    }
    const value = body as Record<string, unknown>;
    if (value.action === "password-reset") {
      const result = await issueAccountPasswordReset(await getMongoDatabase(), await actor(), {
        targetPrincipalId: typeof value.targetPrincipalId === "string" ? value.targetPrincipalId : "",
        expectedRevision: typeof value.expectedRevision === "number" ? value.expectedRevision : -1,
      });
      const resetUrl = new URL("/reset-password", request.url);
      resetUrl.hash = result.recovery.token;
      return Response.json({
        account: result.account,
        recovery: { resetUrl: resetUrl.toString(), expiresAt: result.recovery.expiresAt },
      }, { status: 201, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
    }
    const result = typeof value.email === "string"
      ? await createEditorInvitation(await getMongoDatabase(), await actor(), value.email)
      : await renewEditorInvitation(await getMongoDatabase(), await actor(), {
        targetPrincipalId: typeof value.targetPrincipalId === "string" ? value.targetPrincipalId : "",
        expectedRevision: typeof value.expectedRevision === "number" ? value.expectedRevision : -1,
      });
    const signupUrl = new URL("/signup/editor", request.url);
    signupUrl.searchParams.set("token", result.invitation.token);
    return Response.json(
      { account: result.account, invitation: { signupUrl: signupUrl.toString(), expiresAt: result.invitation.expiresAt } },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const denied = await operatorGuard(request);
  if (denied) return denied;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AccessPolicyError("Request body must be a JSON object", 400);
    }
    const value = body as Record<string, unknown>;
    const account = await deleteAccessAccount(await getMongoDatabase(), await actor(), {
      targetPrincipalId: typeof value.targetPrincipalId === "string" ? value.targetPrincipalId : "",
      expectedRevision: typeof value.expectedRevision === "number" ? value.expectedRevision : -1,
    });
    return Response.json({ account }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const denied = await operatorGuard(request);
  if (denied) return denied;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AccessPolicyError("Request body must be a JSON object", 400);
    }
    const value = body as Record<string, unknown>;
    const update: AccessPolicyUpdate = {
      targetPrincipalId: typeof value.targetPrincipalId === "string" ? value.targetPrincipalId : "",
      expectedRevision: typeof value.expectedRevision === "number" ? value.expectedRevision : -1,
      ...(value.role === undefined ? {} : { role: value.role as AccessPolicyUpdate["role"] }),
      ...(value.enabled === undefined ? {} : { enabled: value.enabled as boolean }),
      ...(value.publicationIds === undefined ? {} : { publicationIds: value.publicationIds as string[] }),
    };
    const account = await updateAccessPolicy(await getMongoDatabase(), await actor(), update);
    return Response.json({ account }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
