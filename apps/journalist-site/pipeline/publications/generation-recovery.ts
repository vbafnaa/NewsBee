import type { Principal } from "../accounts/identity";
import { principalById } from "../accounts/identity";
import { assertGlobalAdmission, preparePolicyBinding, resolveExecutionProviderPolicy, type ExecutionBinding } from "../accounts/execution";
import { ExecutionBlocked, executionBlock } from "../core/execution-errors";
import { callsToday, modelBudget, ModelBudgetExceeded, startOfDay } from "../model/budget";
import { UsageAccountingError } from "../model/runtime";
import { acquireAdmissionLease, acquirePublicationGenerationLease, acquireRunLease, activeRunExecutions, releaseLease, runJobs, type Lease } from "../orchestration/jobs";
import type { OrchestratorDeps } from "../orchestration/orchestrator";
import { RunConflict, runs, stageKinds } from "../orchestration/runs";
import { retryFailedStep } from "../orchestration/retry-step";
import { COLLECTIONS } from "../storage/mongo";
import { assertSiteOpen, MaintenanceError, withSiteWriter } from "../../../../shared/restore-maintenance";
import { assertPublicationWrite, resolvePrivilegedPublicationContext, resolvePublicationContext } from "./access";
import { publicationChangeTransaction } from "./audit";
import { publicationLifecycleFilter, PublicationLifecycleConflict } from "./lifecycle";
import { hasPublicationCapability, PublicationAccessDenied } from "./permissions";
import type { PublicationSettingsDocument } from "./settings";
import { reconcilePublicationGeneration, startGenerationChildren, validateGenerationLocations, type PublicationGeneration } from "./generation";
import { ensurePublicationGenerationAdmissionIndex } from "./generation-status";

type RecoveryInput = {
  publicationId: string;
  generationId: string;
  action: "cancel" | "retry" | "resume";
  funding?: "platform" | "personal";
  reason?: string;
};

/** Recovery is deliberate, target-bound authorization, never a polling side effect. */
export async function recoverPublicationGeneration(deps: OrchestratorDeps, actor: Principal, input: RecoveryInput) {
  return withSiteWriter(deps.db, () => recoverPublicationGenerationAdmitted(deps, actor, input));
}

async function recoverPublicationGenerationAdmitted(deps: OrchestratorDeps, actor: Principal, input: RecoveryInput) {
  await assertSiteOpen(deps.db);
  await ensurePublicationGenerationAdmissionIndex(deps.db);
  const principal = await principalById(deps.db, actor.id);
  if (!principal) throw new PublicationAccessDenied();
  const context = await resolvePublicationContext<PublicationSettingsDocument>(deps.db, principal.id, input.publicationId)
    ?? (hasPublicationCapability(principal, "publication:inspect")
      ? await resolvePrivilegedPublicationContext<PublicationSettingsDocument>(deps.db, principal, input.publicationId,
        `${input.action} publication generation`, "write") : null);
  if (!context) throw new PublicationAccessDenied();
  await assertPublicationWrite(deps.db, context, `${input.action}_publication_generation`);
  const admission = await acquireAdmissionLease(deps.db);
  if (!admission) throw new RunConflict("Generation admission is busy. Retry shortly.");
  const held: Lease[] = [admission];
  let changed: PublicationGeneration | null = null;
  let startedRecovery = false;
  try {
    const lease = await acquirePublicationGenerationLease(deps.db, input.generationId);
    if (!lease) throw new RunConflict("This generation is changing. Reload and retry.");
    held.push(lease);
    const collection = deps.db.collection<PublicationGeneration>(COLLECTIONS.publicationGenerations);
    const generation = await collection.findOne({ _id: input.generationId, publication_id: context.id });
    if (!generation) throw new PublicationAccessDenied();
    if (["ready", "cancelled"].includes(generation.status)) throw new RunConflict("This generation is already finished.");
    if (generation.status === "cancelling") {
      if (input.action !== "cancel") throw new RunConflict("Cancellation must settle before starting new work.");
      return generation;
    }
    if (input.action !== "cancel" && !["blocked", "paused", "failed"].includes(generation.status)) {
      throw new RunConflict("Only a blocked or failed generation can be recovered.");
    }
    const children = await runs(deps.db).find({ publication_generation_id: generation._id }).toArray();
    const bindings = new Map<string, ExecutionBinding>();
    if (input.action !== "cancel") {
      if (principal.role === "admin" && input.funding === "platform") {
        throw new ExecutionBlocked("Administrators must use personal API keys, including when assigned newsroom journalist rights.");
      }
      if (principal.role === "editor" && input.funding === "personal") {
        throw new ExecutionBlocked("Assigned Journalist accounts use managed services. Choose managed funding to recover this work.");
      }
      await assertGlobalAdmission(deps.db, undefined, generation._id, true);
      await validateGenerationLocations(deps.db, context, generation.locations.map(({ id }) => id));
      for (const child of children) {
        const runLease = await acquireRunLease(deps.db, child._id);
        if (!runLease) throw new RunConflict("Wait for the executing location worker to settle before recovery.");
        held.push(runLease);
        if ((await runJobs(deps.db, child._id)).some((job) => job.status === "running")
          || await activeRunExecutions(deps.db, [child._id])) {
          throw new RunConflict("Wait for the executing location worker to settle before recovery.");
        }
        if (child.status === "built") continue;
        if (["published", "cancelled"].includes(child.status)) throw new RunConflict("This location is already published or cancelled; start a new generation.");
        // An uncertain paid result cannot be replayed as a new paid request.
        if (child.execution_blocked?.code === "model_usage_accounting_failed"
          || generation.execution_blocked?.code === "model_usage_accounting_failed") {
          throw new UsageAccountingError(child.execution_blocked?.reason ?? generation.execution_blocked!.reason);
        }
        const previous = child.execution;
        const differentLegacySponsor = previous?.source !== "platform" && previous?.sponsorId !== principal.id;
        if ((differentLegacySponsor || input.funding && input.funding !== previous?.source) && !input.reason?.trim()) {
          throw new ExecutionBlocked("Choose your own funding and give a reason to deliberately rebind legacy work. Another journalist's personal credentials are never inherited.");
        }
        if (differentLegacySponsor && !input.funding) {
          throw new ExecutionBlocked("Explicit platform sponsorship or your own personal funding is required for another journalist's legacy work.");
        }
        const policy = await resolveExecutionProviderPolicy(deps.db, deps.settings, principal,
          principal.role === "editor" || input.funding === "platform" || !input.funding && previous?.source === "platform"
            ? { kind: "platform", publicationId: context.id, locationId: child.location_id } : { kind: "legacy", known: { principal } });
        if (policy.source !== previous?.source && (!input.funding || !input.reason?.trim())) {
          throw new ExecutionBlocked("The current account role requires different funding. Choose the permitted funding explicitly and give a reason before reconnecting.");
        }
        const binding = await preparePolicyBinding(policy, child.location_id, child.kind ?? "edition", child.options);
        binding.initiatedBy = previous?.initiatedBy ?? generation.initiated_by;
        if (policy.source === "platform") {
          const budget = await modelBudget(deps.db, policy.settings);
          if (budget.exhausted) throw new ModelBudgetExceeded(budget.scope, budget.resets_at, budget.cap);
        } else {
          const used = await callsToday(deps.db, { funding: policy.source, initiatorId: principal.id });
          if (used.total >= policy.settings.modelDailyCalls) {
            throw new ModelBudgetExceeded(policy.source, startOfDay() + 86400, policy.settings.modelDailyCalls);
          }
        }
        bindings.set(child._id, binding);
        if (input.action === "resume" && child.status === "failed") throw new RunConflict("Use Retry missing/failed work for this generation.");
      }
      if (generation.locations.length !== children.length && input.action === "resume") {
        throw new RunConflict("Use Retry missing/failed work to create only the missing locations.");
      }
      // Missing children also need today's whole-provider and shared-budget admission.
      if (generation.locations.length !== children.length) {
        const policy = await resolveExecutionProviderPolicy(deps.db, deps.settings, principal, { kind: "platform", publicationId: context.id });
        if ((policy.source === "platform") !== generation.managed_execution && (!input.funding || !input.reason?.trim())) {
          throw new ExecutionBlocked("The current account role requires different funding. Choose the permitted funding explicitly and give a reason before reconnecting.");
        }
        await preparePolicyBinding(policy, generation.locations[0].id, "edition", generation.options);
        if (policy.source === "platform") {
          const budget = await modelBudget(deps.db, policy.settings);
          if (budget.exhausted) throw new ModelBudgetExceeded(budget.scope, budget.resets_at, budget.cap);
        } else if ((await callsToday(deps.db, { funding: policy.source, initiatorId: principal.id })).total >= policy.settings.modelDailyCalls) {
          throw new ModelBudgetExceeded(policy.source, startOfDay() + 86400, policy.settings.modelDailyCalls);
        }
      }
    }
    await publicationChangeTransaction(deps.db, async (session) => {
      await assertPublicationWrite(deps.db, context, `${input.action}_publication_generation`, { session });
      const currentActor = await deps.db.collection("journalist_admins").updateOne(
        { principalId: principal.id, enabled: true }, { $inc: { generationRecoverySequence: 1 } }, { session });
      if (!currentActor.matchedCount) throw new PublicationAccessDenied();
      const claimed = await deps.db.collection(COLLECTIONS.outputChannels).updateOne(
        publicationLifecycleFilter(context, context.publication.lifecycle_revision ?? 0),
        { $inc: { lifecycle_revision: 1 } }, { session });
      if (!claimed.matchedCount) throw new PublicationLifecycleConflict();
      changed = await collection.findOneAndUpdate(
        { _id: generation._id, publication_id: context.id, status: generation.status, updated_at: generation.updated_at },
        { $set: { status: input.action === "cancel" ? "cancelling" : "blocked", updated_at: Date.now() / 1000,
          ...(input.action === "cancel" ? { error: `Cancelled by ${principal.email}; waiting for executing work to settle.` } : {}) } },
        { returnDocument: "after", session });
      if (!changed) throw new RunConflict("The generation changed. Reload and retry.");
      await deps.db.collection("journalist_execution_audit").insertOne({
        publication_id: context.id, generation_id: generation._id, by: principal.id, action: input.action,
        reason: input.reason?.trim() ?? null, funding: input.funding ?? null,
        bindings: children.filter((child) => bindings.has(child._id)).map((child) => ({
          run_id: child._id, previous: child.execution ?? null, next: bindings.get(child._id),
        })), at: Date.now() / 1000,
      }, { session });
    });
    if (input.action !== "cancel") {
      for (const child of children) {
        const binding = bindings.get(child._id);
        if (!binding) continue;
        const updated = await runs(deps.db).updateOne({ _id: child._id, status: child.status, updated_at: child.updated_at }, {
          $set: { execution: binding, updated_at: Date.now() / 1000, stage_started_at: Date.now() / 1000 },
          $unset: { execution_blocked: "" },
        });
        if (!updated.matchedCount) throw new RunConflict("A location changed during recovery. Reload and retry.");
        if (child.status === "failed") {
          const jobs = await runJobs(deps.db, child._id);
          const failed = jobs.filter((job) => job.status === "failed");
          if (!failed.length) throw new RunConflict("The failed location has no durable failed step to retry.");
          for (const job of failed) await retryFailedStep(deps.db, child._id, job._id, principal.email);
        }
        const current = await runs(deps.db).findOne({ _id: child._id });
        const interrupted = (await runJobs(deps.db, child._id)).filter((job) =>
          ["failed", "cancelled"].includes(job.status) && current && stageKinds(current).includes(job.kind));
        for (const job of interrupted) await retryFailedStep(deps.db, child._id, job._id, principal.email);
      }
      const starting = await collection.findOneAndUpdate({ _id: generation._id, status: "blocked" }, {
        $set: { status: "starting", error: null, completed_at: null, updated_at: Date.now() / 1000 },
        $unset: { execution_blocked: "" },
      }, { returnDocument: "after" });
      if (!starting) throw new RunConflict("The generation changed during recovery.");
      startedRecovery = true;
      changed = await startGenerationChildren(deps, principal, starting);
    }
  } catch (error) {
    if (startedRecovery && !(error instanceof MaintenanceError)) {
      await deps.db.collection<PublicationGeneration>(COLLECTIONS.publicationGenerations).updateOne({
        _id: input.generationId, publication_id: context.id, status: "starting",
      }, { $set: { status: "blocked", error: error instanceof Error ? error.message : String(error),
        execution_blocked: executionBlock(error), completed_at: null, updated_at: Date.now() / 1000 } });
    }
    throw error;
  } finally {
    for (const lease of held.reverse()) await releaseLease(deps.db, lease);
  }
  return input.action === "cancel"
    ? await reconcilePublicationGeneration(deps.db, input.generationId)
    : changed;
}
