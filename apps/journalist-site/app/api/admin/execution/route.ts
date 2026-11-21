import { adminRoute, jsonBody, kickPipeline } from "@/lib/admin-api";
import { assertBindingCurrent, assertGlobalAdmission, assertSponsor, capabilityReasons, globalBlocker, globalBlockerDestination, preparePolicyBinding, resolveExecutionProviderPolicy, userDefaultOptions } from "@/pipeline/accounts/execution";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";
import { safeError } from "@/pipeline/core/redaction";
import { resolveRunOptions } from "@/pipeline/core/run-options";
import { ACTIVE_RUN_STATUSES, getRun, RESTARTABLE_RUN_STATUSES, RunConflict, runs } from "@/pipeline/orchestration/runs";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

export async function GET(request: Request) {
  return adminRoute(request, async (deps) => {
    const principal = deps.principal!;
    let platform: Awaited<ReturnType<typeof resolveExecutionProviderPolicy>> | undefined;
    let settingsError: string | null = null;
    try { platform = await resolveExecutionProviderPolicy(deps.db, deps.settings, principal, { kind: "platform" }); }
    catch (error) { settingsError = safeError(error); }
    let editionReasons: string[] = [], mapReasons: string[] = [];
    try {
      if (!platform) throw new ExecutionBlocked(settingsError!);
      const input = new URL(request.url).searchParams.get("options");
      const options = input ? resolveRunOptions(JSON.parse(input)) : userDefaultOptions(platform.settings);
      editionReasons = capabilityReasons(platform.settings, options, options.flow === "agentic", { source: platform.source, configured: Boolean(platform.profile) || platform.source === "platform" });
      mapReasons = capabilityReasons(platform.settings, options, (options.map_flow ?? options.flow) === "agentic", { source: platform.source, configured: Boolean(platform.profile) || platform.source === "platform" });
    }
    catch (error) { editionReasons = mapReasons = [safeError(error)]; }
    const reasons = [...editionReasons, ...mapReasons.filter((reason) => !editionReasons.includes(reason)).map((reason) => `Source map: ${reason}`)];
    const blocker = await globalBlocker(deps.db);
    const recent = await runs(deps.db).find({}).sort({ created_at: -1 }).limit(200).toArray();
    const selectedId = new URL(request.url).searchParams.get("run");
    if (selectedId && !recent.some((run) => run._id === selectedId)) {
      const selected = await getRun(deps.db, selectedId);
      if (selected) recent.push(selected);
    }
    const blockerHref = blocker ? await globalBlockerDestination(deps.db, blocker) : null;
    let legacy: { principal: typeof principal; profile: Awaited<ReturnType<typeof resolveExecutionProviderPolicy>>["profile"] } | undefined;
    let legacyError: string | null = null;
    if (recent.some((run) => run.execution?.sponsorId === principal.id && run.execution.source !== "platform")) {
      try {
        const resolved = await resolveExecutionProviderPolicy(deps.db, deps.settings, principal, { kind: "legacy", known: { principal } });
        legacy = { principal: resolved.principal, profile: resolved.profile };
      } catch (error) { legacyError = safeError(error); }
    }
    const permissions = Object.fromEntries(await Promise.all(recent.map(async (run) => {
      const sponsor = run.execution?.sponsorId === principal.id;
      const platformRun = run.execution?.source === "platform";
      const current = Boolean(run.execution && (platformRun || legacy && !legacy.profile?.revoked
        && run.execution.credentialVersion === (legacy.profile?.version ?? 0)
        && run.execution.source === (legacy.profile?.source ?? "personal")));
      const unfinished = ACTIVE_RUN_STATUSES.includes(run.status);
      const slotReason = blocker && blocker._id !== run._id
        && (!run.publication_generation_id || blocker.publication_generation_id !== run.publication_generation_id)
        ? `Newsroom slot held by ${blocker.location_name}. Resolve its unfinished work before spending here.` : null;
      let reason: string | null = !run.execution
        ? unfinished ? "Legacy run has no credential sponsor. The owner must explicitly claim it or cancel it." : "Legacy history has no execution sponsor. Restart creates a new platform-funded run; it does not fund this old run."
        : !sponsor ? "Only the person who started this run can trigger more provider-backed work."
          : run.execution_blocked?.reason ?? (!current
            ? legacyError ?? (unfinished ? "API settings changed: explicitly reconnect this run." : "API settings changed. Restart creates a new platform-funded run; this completed run cannot be reconnected.")
            : slotReason);
      if (!reason) {
        try {
          await assertBindingCurrent(deps.db, run, true, platformRun ? undefined : legacy, deps.settings);
        } catch (error) { reason = safeError(error); }
      }
      let restartReason = run.publication_generation_id
        ? "This location draft is managed by its combined publication generation."
        : blocker ? `Newsroom slot held by ${blocker.location_name}. Finish or cancel it before starting a new run.` : settingsError;
      if (!restartReason) {
        try {
          const options = resolveRunOptions(run.options ?? { mode: "manual" });
          restartReason = capabilityReasons(platform!.settings, options, (run.kind === "map" ? options.map_flow ?? options.flow : options.flow) === "agentic", { source: platform!.source }).join(" ") || null;
        } catch (error) { restartReason = safeError(error); }
      }
      return [run._id, {
        canSpend: sponsor && current && !reason,
        canRestart: RESTARTABLE_RUN_STATUSES.includes(run.status) && !restartReason,
        restartReason,
        canReconnect: unfinished && sponsor && Boolean(run.execution_blocked || !current),
        canClaim: principal.role === "owner" && !run.execution && unfinished,
        reason,
        paused: run.execution_blocked?.reason ?? (!current && sponsor ? "API settings changed." : null),
      }];
    })));
    return {
      credentialSource: platform?.source ?? "personal",
      principal, reasons, editionReasons, mapReasons, canStart: reasons.length === 0 && !blocker,
      canStartEdition: editionReasons.length === 0 && !blocker, canStartMap: mapReasons.length === 0 && !blocker, permissions,
      blocker: blocker ? {
        id: blocker._id, locationId: blocker.location_id, locationName: blocker.location_name, status: blocker.status,
        paused: blocker.execution_blocked?.reason ?? null, kind: blocker.blocker_kind ?? (blocker.publication_generation_id ? "publication_child" : "run"),
        publicationGenerationId: blocker.publication_generation_id ?? (blocker.blocker_kind ? blocker._id : null),
        href: blockerHref,
      } : null,
    };
  });
}

export async function POST(request: Request) {
  return adminRoute(request, async (deps) => {
    const body = await jsonBody<{ action?: string; runId?: string }>(request);
    if (!body.runId || !["reconnect", "claim"].includes(body.action ?? "")) throw new Error("Invalid reconnect/claim request.");
    const principal = deps.principal!;
    const run = body.action === "claim" ? await getRun(deps.db, body.runId) : await assertSponsor(deps.db, body.runId, principal);
    if (run?.publication_generation_id) throw new RunConflict("Use the target generation's publication recovery controls for combined location work.");
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) throw new RunConflict("Only unfinished runs can be reconnected or claimed.");
    if (body.action === "claim" && (principal.role !== "owner" || run.execution)) throw new ExecutionBlocked("Only the owner can explicitly claim an unbound legacy run.");
    await assertGlobalAdmission(deps.db, run._id, run.publication_generation_id);
    if (await deps.db.collection(COLLECTIONS.jobs).countDocuments({ run_id: run._id, status: "running" })) throw new RunConflict("Wait for the already executing worker to finish before reconnecting.");
    const policy = await resolveExecutionProviderPolicy(deps.db, deps.settings, principal,
      run.execution?.source === "platform"
        ? { kind: "platform" }
        : { kind: "legacy", known: { principal } });
    const choices = run.options ?? userDefaultOptions(policy.settings);
    const options = resolveRunOptions(choices);
    const binding = await preparePolicyBinding(policy, run.location_id, run.kind ?? "edition", options);
    const updated = await runs(deps.db).findOneAndUpdate(
      { _id: run._id, updated_at: run.updated_at, status: run.status },
      {
        $set: {
          execution: binding,
          options,
          admission: run.publication_generation_id ? "publication" : "newsroom",
          updated_at: Date.now() / 1000,
          stage_started_at: Date.now() / 1000,
        },
        $unset: { execution_blocked: "" },
      },
      { returnDocument: "after" });
    if (!updated) throw new RunConflict("Run changed during reconnection. Reload and retry.");
    await deps.db.collection("journalist_execution_audit").insertOne({
      run_id: run._id, by: principal.id, action: body.action, source: binding.source,
      credential_version: binding.credentialVersion, at: Date.now() / 1000,
    });
    kickPipeline(deps, request.url);
    return { run_id: run._id, reconnected: true };
  });
}
