import { adminRoute, jsonBody } from "@/lib/admin-api";
import { APPROVALS, approvalRequestPlan, approvalStaleReason, assertGlobalAdmission, assertSponsor, decideApproval, normalizedPlan, prepareBinding, requestApproval, type Approval, type ApprovalView } from "@/pipeline/accounts/execution";
import { effectiveCredentialProfile } from "@/pipeline/accounts/credentials";
import { getLocation } from "@/pipeline/communities/locations";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";
import { safeError } from "@/pipeline/core/redaction";
import { ACTIVE_RUN_STATUSES } from "@/pipeline/orchestration/runs";
import type { Db } from "mongodb";
import type { Principal } from "@/pipeline/accounts/identity";

type PlanInput = { locationId?: string; kind?: string; options?: unknown; runId?: string };
async function requestInput(db: Db, principal: Principal, input: PlanInput): Promise<{ locationId: string; kind: "map" | "edition"; options: unknown; runId: string | undefined }> {
  let { locationId, kind, options } = input;
  if (input.runId) {
    const run = await assertSponsor(db, input.runId, principal);
    if (!ACTIVE_RUN_STATUSES.includes(run.status) || run.execution?.purpose !== "final" || run.options?.purpose !== "final") throw new ExecutionBlocked("Only an unfinished original final run may request a reconnect approval. Test/training runs cannot be converted to Admin funding.");
    locationId = run.location_id; kind = run.kind ?? "edition"; options = run.options;
  }
  if (!locationId || (kind !== "map" && kind !== "edition")) throw new Error("Invalid approval plan: choose a location and map or edition.");
  await getLocation(db, locationId);
  return { locationId, kind, options, runId: input.runId };
}

export async function GET(request: Request) {
  return adminRoute(request, async ({ db, principal, settings }) => {
    const query = new URL(request.url).searchParams;
    const mine = principal!.role !== "owner" || query.get("mine") === "1";
    const inline = query.has("options") || query.has("runId");
    let options: unknown;
    if (query.has("options")) {
      try { options = JSON.parse(query.get("options")!); }
      catch { throw new Error("Invalid approval options JSON."); }
    }
    const selected = inline ? await requestInput(db, principal!, {
      locationId: query.get("locationId") ?? undefined, kind: query.get("kind") ?? undefined,
      options, runId: query.get("runId") ?? undefined,
    }) : null;
    const profile = selected ? await effectiveCredentialProfile(db, principal!) : null;
    const plan = selected ? normalizedPlan(selected.locationId, selected.kind, selected.options, profile) : null;
    let requestReason: string | null = null;
    if (selected) {
      try { await approvalRequestPlan(db, principal!, selected.locationId, selected.kind, selected.options); }
      catch (error) { requestReason = safeError(error); }
    }
    const filter = {
      ...(mine ? { sponsorId: principal!.id } : {}),
      ...(selected ? { "plan.locationId": selected.locationId, "plan.kind": selected.kind, targetRunId: selected.runId ?? null } : {}),
    };
    const collection = db.collection<Approval>(APPROVALS);
    const rows = !mine && !selected ? (await Promise.all([
      collection.find({ ...filter, status: "requested" }).sort({ createdAt: -1 }).limit(100).toArray(),
      collection.find({ ...filter, status: { $ne: "requested" } }).sort({ createdAt: -1 }).limit(100).toArray(),
    ])).flat() : await collection.find(filter).sort({ createdAt: -1 }).limit(100).toArray();
    const approvals: ApprovalView[] = await Promise.all(rows.map(async (approval) => {
      const staleReason = await approvalStaleReason(db, approval);
      const matchesPlan = !plan || JSON.stringify(plan) === JSON.stringify(approval.plan);
      let blockedReason = staleReason ?? (approval.runId ? "This approval is already connected to a run." : approval.status !== "approved" ? `Request is ${approval.status}.` : !matchesPlan ? "Run options changed. Request approval for the current plan." : approval.sponsorId !== principal!.id ? "Only the original requester can start this approved plan in its location pipeline." : null);
      if (!blockedReason) {
        try {
          await prepareBinding(db, settings, principal!, approval.plan.locationId, approval.plan.kind, { ...approval.plan.options, admin_approval_id: approval._id }, approval.targetRunId ?? undefined);
          await assertGlobalAdmission(db, approval.targetRunId ?? undefined);
        } catch (error) { blockedReason = safeError(error); }
      }
      return { ...approval, staleReason, matchesPlan, canStart: !blockedReason, blockedReason };
    }));
    return { principal, approvals, canRequest: Boolean(selected && !requestReason), requestReason };
  });
}

export async function POST(request: Request) {
  return adminRoute(request, async ({ db, principal }) => {
    const body = await jsonBody<PlanInput & { action?: string; id?: string }>(request);
    if (body.action === "request") {
      const { locationId, kind, options } = await requestInput(db, principal!, body);
      return { approval: await requestApproval(db, principal!, locationId, kind, options, body.runId ?? null) };
    }
    if (!body.id || !["approved", "rejected", "revoked"].includes(body.action ?? "")) throw new Error("Invalid approval decision.");
    return { approval: await decideApproval(db, principal!, body.id, body.action as "approved" | "rejected" | "revoked") };
  });
}
