import { adminRoute, jsonBody, kickPipeline } from "@/lib/admin-api";
import { effectiveCredentialProfile } from "@/pipeline/accounts/credentials";
import { assertBindingCurrent, assertGlobalAdmission, assertSponsor, blockExecution, capabilityReasons, consumeApproval, credentialContext, globalBlocker, personalSettings, prepareBinding, userDefaultOptions } from "@/pipeline/accounts/execution";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";
import { safeError } from "@/pipeline/core/redaction";
import { resolveRunOptions } from "@/pipeline/core/run-options";
import { ACTIVE_RUN_STATUSES, getRun, RunConflict, runs } from "@/pipeline/orchestration/runs";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

export async function GET(request: Request) {
  return adminRoute(request, async (deps) => {
    const principal = deps.principal!;
    const profile = await effectiveCredentialProfile(deps.db, principal);
    const context = credentialContext(principal, profile);
    let settings: ReturnType<typeof personalSettings> | undefined;
    let settingsError: string | null = null;
    try { settings = personalSettings(deps.settings, principal, profile); }
    catch (error) { settingsError = safeError(error); }
    let editionReasons: string[] = [], mapReasons: string[] = [];
    try {
      if (!settings) throw new ExecutionBlocked(settingsError!);
      const input = new URL(request.url).searchParams.get("options");
      const options = input ? resolveRunOptions(JSON.parse(input)) : userDefaultOptions(settings);
      editionReasons = capabilityReasons(settings, options, false, options.flow === "agentic", context);
      mapReasons = capabilityReasons(settings, options, false, (options.map_flow ?? options.flow) === "agentic", context);
    }
    catch (error) { editionReasons = mapReasons = [safeError(error)]; }
    const reasons = [...editionReasons, ...mapReasons.filter((reason) => !editionReasons.includes(reason)).map((reason) => `Source map: ${reason}`)];
    const blocker = await globalBlocker(deps.db);
    const recent = await runs(deps.db).find({}).sort({ created_at: -1 }).limit(200).toArray();
    const permissions = Object.fromEntries(await Promise.all(recent.map(async (run) => {
      const sponsor = run.execution?.sponsorId === principal.id;
      const current = Boolean(run.execution && !profile?.revoked && run.execution.credentialVersion === (profile?.version ?? 0) && run.execution.source === (profile?.source ?? "personal"));
      const unfinished = ACTIVE_RUN_STATUSES.includes(run.status);
      const slotReason = blocker && blocker._id !== run._id ? `Newsroom slot held by ${blocker.location_name}. Resolve its unfinished run before spending here.` : null;
      let reason: string | null = !run.execution
        ? unfinished ? "Legacy run has no credential sponsor. The owner must explicitly claim it or cancel it." : "Legacy history has no credential sponsor. Restart creates a new run with your own saved credentials; it does not fund this old run."
        : !sponsor ? "Only this run's original sponsor can trigger paid work."
          : run.execution_blocked?.reason ?? (!current ? unfinished ? "API settings changed: explicitly reconnect this run." : "API settings changed. Restart as a new run with your saved credentials; this completed run cannot be reconnected." : slotReason);
      if (!reason) {
        try {
          await assertBindingCurrent(deps.db, run, true);
          if (!settings) throw new ExecutionBlocked(settingsError!);
          const options = resolveRunOptions(run.options);
          reason = capabilityReasons(settings, options, Boolean(run.execution?.approvalId), (run.kind === "map" ? options.map_flow ?? options.flow : options.flow) === "agentic", context).join(" ") || null;
        } catch (error) { reason = safeError(error); }
      }
      let restartReason = blocker ? `Newsroom slot held by ${blocker.location_name}. Finish or cancel it before starting a new run.` : settingsError;
      if (!restartReason) {
        try {
          const options = resolveRunOptions(run.options ?? { mode: "manual" });
          restartReason = capabilityReasons(settings!, options, false, (run.kind === "map" ? options.map_flow ?? options.flow : options.flow) === "agentic", context).join(" ") || null;
        } catch (error) { restartReason = safeError(error); }
      }
      return [run._id, {
        canSpend: sponsor && current && !reason,
        canRestart: ["mapped", "published", "failed", "cancelled"].includes(run.status) && !restartReason,
        restartReason,
        canReconnect: unfinished && sponsor && Boolean(run.execution_blocked || !current),
        canRequestBackup: unfinished && sponsor && run.execution?.purpose === "final" && run.options?.purpose === "final",
        canClaim: principal.role === "owner" && !run.execution && unfinished,
        reason,
        paused: run.execution_blocked?.reason ?? (!current && sponsor ? "API settings changed." : null),
      }];
    })));
    return {
      principal, reasons, editionReasons, mapReasons, canStart: reasons.length === 0 && !blocker,
      canStartEdition: editionReasons.length === 0 && !blocker, canStartMap: mapReasons.length === 0 && !blocker, permissions,
      blocker: blocker ? { id: blocker._id, locationId: blocker.location_id, locationName: blocker.location_name, status: blocker.status, paused: blocker.execution_blocked?.reason ?? null } : null,
    };
  });
}

export async function POST(request: Request) {
  return adminRoute(request, async (deps) => {
    const body = await jsonBody<{ action?: string; runId?: string; approvalId?: string }>(request);
    if (!body.runId || !["reconnect", "claim"].includes(body.action ?? "")) throw new Error("Invalid reconnect/claim request.");
    const principal = deps.principal!;
    const run = body.action === "claim" ? await getRun(deps.db, body.runId) : await assertSponsor(deps.db, body.runId, principal);
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) throw new RunConflict("Only unfinished runs can be reconnected or claimed.");
    if (body.action === "claim" && (principal.role !== "owner" || run.execution)) throw new ExecutionBlocked("Only the owner can explicitly claim an unbound legacy run.");
    await assertGlobalAdmission(deps.db, run._id);
    if (await deps.db.collection(COLLECTIONS.jobs).countDocuments({ run_id: run._id, status: "running" })) throw new RunConflict("Wait for the already executing worker to finish before reconnecting.");
    const choices = run.options ?? userDefaultOptions(personalSettings(deps.settings, principal, await effectiveCredentialProfile(deps.db, principal)));
    const options = resolveRunOptions({ ...choices, admin_approval_id: body.approvalId });
    const binding = await prepareBinding(deps.db, deps.settings, principal, run.location_id, run.kind ?? "edition", options, run._id);
    const updated = await runs(deps.db).findOneAndUpdate(
      { _id: run._id, updated_at: run.updated_at, status: run.status },
      { $set: { execution: binding, options: { ...options, purpose: binding.purpose }, admission: "newsroom", updated_at: Date.now() / 1000, stage_started_at: Date.now() / 1000 }, $unset: { execution_blocked: "" } },
      { returnDocument: "after" });
    if (!updated) throw new RunConflict("Run changed during reconnection. Reload and retry.");
    try { await consumeApproval(deps.db, updated); }
    catch (error) {
      await blockExecution(deps.db, run._id, "Approval could not be connected. Request a fresh owner approval before continuing.");
      throw error;
    }
    await deps.db.collection("journalist_execution_audit").insertOne({ run_id: run._id, by: principal.id, action: body.action, credential_version: binding.credentialVersion, at: Date.now() / 1000 });
    kickPipeline(deps, request.url);
    return { run_id: run._id, reconnected: true };
  });
}
