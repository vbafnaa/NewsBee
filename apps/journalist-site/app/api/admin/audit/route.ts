import { adminRoute } from "@/lib/admin-api";
import { listGovernanceAudit, type GovernanceAuditFilter } from "@/pipeline/publications/governance-audit";
import { AccessPolicyError } from "@/pipeline/accounts/access-policy";

export async function GET(request: Request) {
  return adminRoute(request, async (deps) => {
    const query = new URL(request.url).searchParams;
    const filter: GovernanceAuditFilter = {};
    for (const key of ["cursor", "publicationId", "actorId", "targetId", "action", "kind"] as const) {
      if (query.has(key)) Object.assign(filter, { [key]: query.get(key) });
    }
    for (const key of ["limit", "from", "to"] as const) {
      if (query.has(key)) Object.assign(filter, { [key]: query.get(key)?.trim() ? Number(query.get(key)) : NaN });
    }
    try { return await listGovernanceAudit(deps.db, deps.principal!, filter); }
    catch (error) {
      if (error instanceof AccessPolicyError) return Response.json({ detail: error.message }, { status: error.status });
      throw error;
    }
  });
}
