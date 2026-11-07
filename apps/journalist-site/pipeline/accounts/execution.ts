import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { effectiveCredentialProfile, safeProfile, type CredentialProfile, type PersonalConfig } from "./credentials";
import { isConfiguredOwner, principalById, type Principal } from "./identity";
import { loadSettings, type ProviderConfig, type Settings } from "../core/config";
import { ExecutionBlocked } from "../core/execution-errors";
import { safeError } from "../core/redaction";
import { defaultRunOptions, resolveRunOptions, type RunOptions } from "../core/run-options";
import { ACTIVE_RUN_STATUSES, getRun, RunConflict, runs, type PipelineRun } from "../orchestration/runs";

export type ExecutionBinding = {
  sponsorId: string;
  sponsorEmail?: string;
  initiatedBy: string;
  credentialVersion: number;
  source: "personal" | "environment";
  purpose: "test" | "training" | "final";
  planHash: string;
  approvalId: string | null;
};
export type ExecutionPlan = { locationId: string; kind: "map" | "edition"; options: RunOptions; credentialVersion: number; source: "personal" | "environment" };
export type Approval = {
  _id: string; sponsorId: string; sponsorEmail: string; plan: ExecutionPlan; planHash: string;
  status: "requested" | "approved" | "rejected" | "revoked"; createdAt: number;
  decidedBy?: string; decidedAt?: number; adminFingerprint: string; runId: string | null;
  targetRunId: string | null;
};
export type ApprovalView = Approval & { staleReason: string | null; matchesPlan: boolean; canStart: boolean; blockedReason: string | null };
export const APPROVALS = "journalist_run_approvals";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function infrastructureSettings(): Settings {
  const env = process.env;
  // Only operational settings cross this boundary. No provider secret enters worker defaults.
  const infra = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(NEWSBEE_(MODE|ROOT|PIPELINE_DRIVE_FOLDER_ID|RUN_TIMEOUT_MINUTES|COLLECT_CONCURRENCY|COLLECT_BUDGET_MINUTES|AI_LINK_DISCOVERY|WIDER_SOURCES|NEWS_SEARCH|LLM_DISCOVERY)|CRON_SECRET)$/.test(key)));
  return loadSettings({ ...infra, NODE_ENV: process.env.NODE_ENV, NEWSBEE_MODEL_PROVIDERS: "gemini" });
}

export function adminBackup(): ProviderConfig {
  const baseUrl = process.env.NEWSBEE_ADMIN_LLM_BASE_URL ?? process.env.NEWSBEE_LLM_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.NEWSBEE_ADMIN_LLM_MODEL ?? process.env.NEWSBEE_LLM_OPENAI_MODEL;
  const apiKey = process.env.NEWSBEE_ADMIN_LLM_API_KEY ?? process.env.NEWSBEE_LLM_OPENAI_API_KEY;
  if (!model || !apiKey || !/^https:\/\//.test(baseUrl)) throw new ExecutionBlocked("Admin OpenAI backup is not configured by the owner.");
  return {
    name: "admin_backup", kind: "openai", baseUrl: baseUrl.replace(/\/$/, ""), model, apiKey, authHeader: null,
    maxTokensParam: "max_completion_tokens", temperature: null, jsonMode: "json_schema",
    usage: { inputCostPerMTok: null, outputCostPerMTok: null, requestsPerMinute: null, requestsPerDay: null },
  };
}
function adminFingerprint() {
  const provider = adminBackup();
  return hash({ endpoint: provider.baseUrl, model: provider.model, apiKey: provider.apiKey, version: process.env.NEWSBEE_ADMIN_LLM_VERSION ?? "1" });
}
export function personalSettings(base: Settings, principal: Principal, profile: CredentialProfile | null): Settings {
  if (profile?.revoked) throw new ExecutionBlocked("Your API credentials were revoked. Save and reconnect credentials before continuing.");
  if (profile?.source === "environment") {
    if (!isConfiguredOwner(principal)) throw new ExecutionBlocked("Deployment credentials are restricted to the exact NEWSBEE_OWNER_EMAIL account.");
    return loadSettings();
  }
  const config: PersonalConfig | null = profile?.config ?? null;
  return {
    ...base,
    modelProviders: config?.modelProviders ?? [],
    tavilySearchApiKey: config?.tavilySearchApiKey ?? null,
    integrations: config?.integrations ?? base.integrations,
    lightModel: config?.lightModel ?? base.lightModel,
    modelDailyCalls: config?.modelDailyCalls ?? base.modelDailyCalls,
  };
}
export function profileMetadata(principal: Principal, profile: CredentialProfile | null) {
  let configurationError: string | null = null;
  let resolved: Settings | undefined;
  if (profile?.source === "environment" && !profile.revoked) {
    try { resolved = personalSettings(infrastructureSettings(), principal, profile); }
    catch (error) { configurationError = `Deployment settings are invalid: ${safeError(error)}`; }
  }
  return profile ? { ...safeProfile(profile, resolved)!, configurationError } : null;
}

export function credentialContext(principal: Principal, profile: CredentialProfile | null) {
  return { owner: principal.role === "owner", source: profile?.source ?? "personal", configured: Boolean(profile) };
}
export function capabilityReasons(settings: Settings, options: RunOptions, allowAdmin = false, searchNeeded = false, needs: { model?: boolean; agent?: boolean; owner?: boolean; source?: "personal" | "environment"; configured?: boolean } = {}): string[] {
  const reasons: string[] = [];
  const models = settings.modelProviders.filter((provider) => provider.apiKey && provider.model);
  const deployment = needs.source === "environment";
  if (needs.model !== false && !models.length && !allowAdmin) reasons.push(deployment
    ? "Deployment defaults have no model with both a model name and API key. Configure NEWSBEE_MODEL_PROVIDERS and its NEWSBEE_GEMINI_API_KEY or NEWSBEE_LLM_<NAME>_MODEL/API_KEY on the server, or optionally save personal keys."
    : needs.owner && !needs.configured
      ? "Deployment defaults are available only to the exact configured NEWSBEE_OWNER_EMAIL account. Check the owner designation or save a personal model API key and model."
      : "Add a personal model API key and model in My API settings, or request owner approval for a final run.");
  const modelAllowed = models.some((provider) => (options.paid[provider.kind === "gemini" ? "gemini" : "openai_compatible"] ?? 0) > 0);
  if (needs.model !== false && (models.length || allowAdmin) && !modelAllowed && !(allowAdmin && (options.paid.openai_compatible ?? 0) > 0)) reasons.push("Enable a configured model's paid-call budget for this run.");
  const keys = settings.integrations;
  const searchKeys = { serpapi: keys.serpapiKey, searchapi: keys.searchapiKey, brightdata: keys.brightdataKey && keys.brightdataZone, exa: keys.exaKey, tavily: settings.tavilySearchApiKey, fixture: null };
  if (searchNeeded) {
    if (options.search_provider === "fixture") reasons.push("Fixture search cannot be used for admitted newsroom runs.");
    else {
      if (!searchKeys[options.search_provider]) reasons.push(deployment
        ? `Configure deployment ${options.search_provider} search credentials${options.search_provider === "brightdata" ? " and zone" : ""} on the server, or choose a configured search provider.`
        : `Add your own ${options.search_provider} search credentials${options.search_provider === "brightdata" ? " and zone" : ""}.`);
      if (!(options.paid[options.search_provider] && options.paid[options.search_provider]! > 0)) reasons.push(`Enable ${options.search_provider}'s paid-call budget.`);
    }
    if (needs.agent !== false && !(options.paid.agent_model && options.paid.agent_model > 0)) reasons.push("Enable the agent model budget for agentic work.");
  }
  if (options.classifier !== "off" && !(keys.typesafeKey || keys.openrouterKey)) reasons.push(`Jev classification needs ${deployment ? "a deployment" : "your own"} TypeSafe or OpenRouter key, or switch classification off.`);
  for (const [service, present] of Object.entries({ scrapingbee: keys.scrapingbeeKey, attom: keys.attomKey, jev: keys.typesafeKey || keys.openrouterKey })) {
    if ((options.paid[service as keyof RunOptions["paid"]] ?? 0) > 0 && !present) reasons.push(`${service} is enabled but has no ${deployment ? "deployment" : "personal"} key. Disable it or ${deployment ? "configure it on the server" : "add your own key"}.`);
  }
  return reasons;
}
export function userDefaultOptions(settings: Settings): RunOptions {
  const options = defaultRunOptions();
  for (const provider of settings.modelProviders) {
    if (provider.apiKey) options.paid[provider.kind === "gemini" ? "gemini" : "openai_compatible"] ??= 200;
  }
  return options;
}
export function normalizedPlan(locationId: string, kind: "map" | "edition", choices: unknown, profile: CredentialProfile | null): ExecutionPlan {
  const options = resolveRunOptions(choices);
  delete options.admin_approval_id;
  if (kind === "map") options.flow = options.map_flow ?? options.flow;
  return { locationId, kind, options, credentialVersion: profile?.version ?? 0, source: profile?.source ?? "personal" };
}
export async function approvalRequestPlan(db: Db, principal: Principal, locationId: string, kind: "map" | "edition", choices: unknown) {
  const profile = await effectiveCredentialProfile(db, principal);
  const plan = normalizedPlan(locationId, kind, choices, profile);
  if (plan.options.purpose !== "final") throw new ExecutionBlocked("Only final runs may request Admin-token backup. Test and training runs are never eligible.");
  if (!(plan.options.paid.openai_compatible && plan.options.paid.openai_compatible > 0)) throw new ExecutionBlocked("Enable the OpenAI-compatible paid-call budget before requesting Admin backup.");
  adminBackup();
  const settings = personalSettings(infrastructureSettings(), principal, profile);
  const reasons = capabilityReasons(settings, plan.options, true, (kind === "map" ? plan.options.map_flow ?? plan.options.flow : plan.options.flow) === "agentic", credentialContext(principal, profile));
  if (reasons.length) throw new ExecutionBlocked(reasons.join(" "));
  return plan;
}
export async function approvalStaleReason(db: Db, approval: Approval): Promise<string | null> {
  try {
    const principal = await principalById(db, approval.sponsorId);
    if (!principal) return "The sponsoring account is disabled.";
    const profile = await effectiveCredentialProfile(db, principal);
    if (profile?.revoked || (profile?.version ?? 0) !== approval.plan.credentialVersion || (profile?.source ?? "personal") !== approval.plan.source) return "API settings changed or were revoked. Request fresh approval for the current credential version.";
    if (approval.plan.options.purpose !== "final" || hash(normalizedPlan(approval.plan.locationId, approval.plan.kind, approval.plan.options, profile)) !== approval.planHash) return "The immutable final-run plan no longer matches. Request fresh approval.";
    if (approval.adminFingerprint !== adminFingerprint()) return "The owner's Admin backup configuration changed. Request fresh approval.";
    if (approval.status === "approved" && (!approval.decidedBy || (await principalById(db, approval.decidedBy))?.role !== "owner")) return "The approving owner is no longer enabled.";
    if (approval.targetRunId && !approval.runId) {
      const run = await getRun(db, approval.targetRunId);
      if (!run || !ACTIVE_RUN_STATUSES.includes(run.status) || run.execution?.sponsorId !== principal.id || run.execution.purpose !== "final") return "The original final run is no longer available for reconnection.";
      if (hash(normalizedPlan(run.location_id, run.kind ?? "edition", run.options, profile)) !== approval.planHash) return "The target run's plan changed. Request fresh approval.";
    }
    return null;
  } catch (error) { return safeError(error); }
}
export async function requestApproval(db: Db, principal: Principal, locationId: string, kind: "map" | "edition", choices: unknown, targetRunId: string | null = null) {
  const plan = await approvalRequestPlan(db, principal, locationId, kind, choices);
  const approval: Approval = {
    _id: randomUUID(), sponsorId: principal.id, sponsorEmail: principal.email, plan, planHash: hash(plan),
    status: "requested", createdAt: Date.now() / 1000, adminFingerprint: adminFingerprint(), runId: null, targetRunId,
  };
  await db.collection<Approval>(APPROVALS).insertOne(approval);
  return approval;
}
export async function decideApproval(db: Db, owner: Principal, id: string, status: "approved" | "rejected" | "revoked") {
  if (owner.role !== "owner") throw new ExecutionBlocked("Only the owner can approve or revoke Admin tokens.");
  if (status === "approved") {
    const request = await db.collection<Approval>(APPROVALS).findOne({ _id: id, status: "requested" });
    if (!request) throw new RunConflict("Approval changed or is no longer available.");
    const stale = await approvalStaleReason(db, request);
    if (stale) throw new ExecutionBlocked(stale);
  }
  const approved = await db.collection<Approval>(APPROVALS).findOneAndUpdate(
    { _id: id, status: status === "revoked" ? "approved" : "requested" },
    { $set: { status, decidedBy: owner.id, decidedAt: Date.now() / 1000 } }, { returnDocument: "after" });
  if (!approved) throw new RunConflict("Approval changed or is no longer available.");
  if (status === "revoked" && approved.runId) await blockExecution(db, approved.runId, "The owner revoked this run's Admin backup approval. Its sponsor must explicitly reconnect personal credentials or obtain fresh approval.");
  return approved;
}
async function validApproval(db: Db, binding: ExecutionBinding, runId?: string) {
  if (!binding.approvalId || binding.purpose !== "final") return null;
  const approval = await db.collection<Approval>(APPROVALS).findOne({ _id: binding.approvalId, sponsorId: binding.sponsorId, planHash: binding.planHash, status: "approved" });
  if (!approval || (approval.runId && approval.runId !== runId) || (approval.targetRunId && approval.targetRunId !== runId) || approval.adminFingerprint !== adminFingerprint()) throw new ExecutionBlocked("Admin approval is missing, revoked, consumed or no longer matches this plan.");
  if (!approval.decidedBy || (await principalById(db, approval.decidedBy))?.role !== "owner") throw new ExecutionBlocked("The approving owner is no longer enabled.");
  return approval;
}
export async function prepareBinding(db: Db, base: Settings, principal: Principal, locationId: string, kind: "map" | "edition", choices: unknown, existingRunId?: string): Promise<ExecutionBinding> {
  const profile = await effectiveCredentialProfile(db, principal);
  const plan = normalizedPlan(locationId, kind, choices, profile);
  if (existingRunId) {
    const previous = await getRun(db, existingRunId);
    if (previous?.execution && (previous.execution.sponsorId !== principal.id || previous.execution.purpose !== plan.options.purpose)) throw new ExecutionBlocked("Reconnect must preserve the original sponsor and run purpose. Test/training work cannot be converted to Admin funding.");
  }
  const input = choices && typeof choices === "object" ? choices as Record<string, unknown> : {};
  const binding: ExecutionBinding = {
    sponsorId: principal.id, sponsorEmail: principal.email, initiatedBy: principal.id, credentialVersion: plan.credentialVersion, source: plan.source,
    purpose: plan.options.purpose ?? "test", planHash: hash(plan), approvalId: typeof input.admin_approval_id === "string" ? input.admin_approval_id : null,
  };
  if (binding.approvalId && binding.purpose !== "final") throw new ExecutionBlocked("Test/training runs cannot use Admin tokens.");
  const approval = await validApproval(db, binding, existingRunId);
  const settings = personalSettings(base, principal, profile);
  const reasons = capabilityReasons(settings, plan.options, Boolean(approval), (kind === "map" ? plan.options.map_flow ?? plan.options.flow : plan.options.flow) === "agentic", credentialContext(principal, profile));
  if (reasons.length) throw new ExecutionBlocked(reasons.join(" "));
  return binding;
}
export async function consumeApproval(db: Db, run: PipelineRun) {
  const binding = run.execution;
  if (!binding?.approvalId) return;
  await validApproval(db, binding, run._id);
  const changed = await db.collection<Approval>(APPROVALS).updateOne({ _id: binding.approvalId, status: "approved", runId: null }, { $set: { runId: run._id } });
  if (!changed.modifiedCount) throw new ExecutionBlocked("This approval has already been used. Request approval for the new run.");
}
export async function assertBindingCurrent(db: Db, run: PipelineRun, allowInactive = false) {
  const binding = run.execution;
  if (!binding) throw new ExecutionBlocked("Legacy run has no credential sponsor. The owner must explicitly claim it or cancel it.");
  const principal = await principalById(db, binding.sponsorId);
  if (!principal) throw new ExecutionBlocked("The sponsoring account is disabled. Further paid work is blocked.");
  const profile = await effectiveCredentialProfile(db, principal);
  if (profile?.revoked || (profile?.version ?? 0) !== binding.credentialVersion || (profile?.source ?? "personal") !== binding.source) throw new ExecutionBlocked("API settings changed or were revoked. This run is paused until its sponsor explicitly reconnects it.");
  if (binding.approvalId) await validApproval(db, binding, run._id);
  if (hash(normalizedPlan(run.location_id, run.kind ?? "edition", run.options, profile)) !== binding.planHash) throw new ExecutionBlocked("The run configuration changed. Reconnect with a new approval before using Admin tokens.");
  const latest = await getRun(db, run._id);
  if (!latest || (!allowInactive && !ACTIVE_RUN_STATUSES.includes(latest.status)) || latest.execution_blocked) throw new ExecutionBlocked(latest?.execution_blocked?.reason ?? "This run is paused or no longer active.");
  return { principal, profile };
}
export async function assertSponsor(db: Db, runId: string, principal: Principal) {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (run.execution?.sponsorId !== principal.id) throw new ExecutionBlocked("Only the original sponsoring editor can trigger additional paid work. Start a new own-sponsored run when the newsroom is available.");
  return run;
}
export async function blockExecution(db: Db, runId: string, reason: string) {
  await runs(db).updateOne({ _id: runId, status: { $in: ACTIVE_RUN_STATUSES } }, { $set: { execution_blocked: { reason, at: Date.now() / 1000 } } });
}
export async function globalBlocker(db: Db, exceptRunId?: string) {
  return runs(db).findOne({ status: { $in: ACTIVE_RUN_STATUSES }, ...(exceptRunId ? { _id: { $ne: exceptRunId } } : {}) }, { sort: { created_at: 1 } });
}
export async function assertGlobalAdmission(db: Db, exceptRunId?: string) {
  const blocker = await globalBlocker(db, exceptRunId);
  if (blocker) throw new RunConflict(`Newsroom busy: ${blocker.location_name} has unfinished run ${blocker._id}. Open /locations/${encodeURIComponent(blocker.location_id)}?tab=runs&run=${blocker._id}. Paused and editor-waiting runs also hold the slot.`);
}
export async function authorizePaidAction(db: Db, runId: string, principal: Principal) {
  const run = await assertSponsor(db, runId, principal);
  await assertGlobalAdmission(db, runId);
  try { await assertBindingCurrent(db, run, true); }
  catch (error) {
    if (error instanceof ExecutionBlocked) await blockExecution(db, runId, error.message);
    throw error;
  }
  return run;
}
