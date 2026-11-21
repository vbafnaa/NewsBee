import { randomUUID } from "node:crypto";
import { adminRoute, jsonBody } from "@/lib/admin-api";
import { currentRestoreGeneration } from "@/lib/admin-session";
import { resolveExecutionProviderPolicy } from "@/pipeline/accounts/execution";
import { campaignCollection, campaignPrompt, claimCampaignRender, publicCampaign, requireCampaignOperator, saveCampaign, type VideoCampaign } from "@/pipeline/campaigns/video-campaigns";
import { falVideoConfigured, falVideoModel, falVideoResult, falVideoStatus, submitFalVideo } from "@/pipeline/connectors/fal-video";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";
import { safeError } from "@/pipeline/core/redaction";
import { RunConflict } from "@/pipeline/orchestration/runs";
import type { OrchestratorDeps } from "@/pipeline/orchestration/orchestrator";
import { runFolder } from "@/pipeline/storage/artifacts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function providerError(error: unknown, key: string | null | undefined) {
  const message = error instanceof Error ? error.message : String(error);
  return safeError(key ? message.split(key).join("[redacted]") : message);
}

async function credentials(deps: OrchestratorDeps) {
  const policy = await resolveExecutionProviderPolicy(deps.db, deps.settings, deps.principal!, { kind: "legacy" });
  requireCampaignOperator(policy.principal);
  const key = policy.settings.integrations.falKey;
  if (!falVideoConfigured(key)) throw new ExecutionBlocked("Add your personal fal.ai key in Personal API keys before creating a video.");
  return { key, version: policy.credentialVersion, source: policy.source };
}

async function load(deps: OrchestratorDeps, id: unknown) {
  if (typeof id !== "string" || id.length > 100) throw new Error("Invalid campaign ID.");
  const campaign = await campaignCollection(deps.db).findOne({ _id: id, createdBy: deps.principal!.id });
  if (!campaign) throw new Error("Unknown video request or campaign.");
  return campaign;
}

async function updateRender(deps: OrchestratorDeps, campaign: VideoCampaign, previousStatus: string) {
  const result = await campaignCollection(deps.db).findOneAndUpdate(
    { _id: campaign._id, createdBy: deps.principal!.id, "render.id": campaign.render!.id, "render.status": previousStatus },
    { $set: { render: campaign.render, updatedAt: Date.now() } }, { returnDocument: "after" },
  );
  if (!result) throw new RunConflict("Campaign render changed. Reload.");
  return result;
}

export async function GET(request: Request) {
  return adminRoute(request, async (deps) => {
    requireCampaignOperator(deps.principal!);
    const query = new URL(request.url).searchParams;
    if (query.has("download")) {
      const campaign = await load(deps, query.get("download"));
      if (campaign.render?.status !== "complete" || !campaign.render.fileId) throw new Error("Unknown video request or video is not ready.");
      if (!deps.store.readBinary) throw new Error("Video storage does not support downloads.");
      const bytes = await deps.store.readBinary(campaign.render.fileId);
      return new Response(new Blob([Uint8Array.from(bytes)]), { headers: {
        "Content-Type": "video/mp4", "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="campaign-${campaign._id}.mp4"`,
        "X-Content-Type-Options": "nosniff",
      } });
    }
    let unavailableReason: string | null = null;
    let fundingSource: string | null = null;
    try { fundingSource = (await credentials(deps)).source; }
    catch (error) {
      if (!(error instanceof ExecutionBlocked)) throw error;
      unavailableReason = error.message;
    }
    const campaigns = await campaignCollection(deps.db).find({ createdBy: deps.principal!.id }).sort({ updatedAt: -1 }).limit(50).toArray();
    return { campaigns: campaigns.map(publicCampaign), configured: !unavailableReason, unavailableReason, fundingSource, model: falVideoModel() };
  });
}

export async function POST(request: Request) {
  return adminRoute(request, async (deps) => {
    requireCampaignOperator(deps.principal!);
    const body = await jsonBody<{ action?: string; id?: unknown; revision?: number; copy?: unknown; confirmPaid?: boolean }>(request);
    if (body.action === "save") return { campaign: publicCampaign(await saveCampaign(deps.db, deps.principal!, body.copy, body.id, body.revision)) };
    const campaign = await load(deps, body.id);
    if (body.action === "render") {
      if (body.confirmPaid !== true) throw new Error("Invalid campaign: explicitly confirm the paid provider charge.");
      if (body.revision !== campaign.revision) throw new RunConflict("Campaign changed. Reload and review before rendering.");
      const prompt = campaignPrompt(campaign);
      if (!deps.store.saveBinary || !deps.store.readBinary) throw new ExecutionBlocked("Video artifact storage is unavailable.");
      const credential = await credentials(deps);
      if (credential.source === "platform") throw new ExecutionBlocked("Managed newsroom funding is unavailable for marketing.");
      // Check storage before admitting a paid request.
      await runFolder(deps.store, "video-production", "campaigns", campaign._id);
      const claimed = await claimCampaignRender(deps.db, campaign, {
        id: randomUUID(), status: "submitting", prompt, script: campaign.script, caption: campaign.caption,
        credentialVersion: credential.version, fundingSource: credential.source,
        identityGeneration: await currentRestoreGeneration(), createdAt: Date.now(),
      });
      await deps.db.collection("journalist_funding_audit").insertOne({
        run_id: claimed.render!.id, sponsor_id: deps.principal!.id, initiator_id: deps.principal!.id,
        credential_version: credential.version, funding: credential.source, funding_identity: "personal",
        provider: "fal", model: falVideoModel(), role: "marketing-video-submission", at: Date.now() / 1000,
      });
      try {
        claimed.render!.requestId = await submitFalVideo(prompt, credential.key);
        claimed.render!.status = "queued";
      } catch (error) {
        // A failed HTTP response can follow provider acceptance. Never automatically resubmit.
        claimed.render!.error = `Submission outcome uncertain. Do not retry: reconcile this attempt with fal.ai support. ${providerError(error, credential.key)}`;
      }
      return { campaign: publicCampaign(await updateRender(deps, claimed, "submitting")) };
    }
    if (body.action === "refresh") {
      const render = campaign.render;
      if (!render) throw new Error("Invalid campaign: no video has been requested.");
      if (["complete", "failed"].includes(render.status)) return { campaign: publicCampaign(campaign) };
      if (!render.requestId) throw new RunConflict(render.error ?? "Submission is still pending or was interrupted. Reconcile this attempt with fal.ai; do not submit it again.");
      if (render.identityGeneration !== await currentRestoreGeneration()) throw new ExecutionBlocked("This render predates a site restore and cannot resume. Reconcile it with the provider.");
      const credential = await credentials(deps);
      if (credential.version !== render.credentialVersion || credential.source !== render.fundingSource) throw new ExecutionBlocked("API settings changed since submission. This attempt must be reconciled with the provider.");
      const previousStatus = render.status;
      try {
        const status = await falVideoStatus(render.requestId, credential.key);
        if (status.status === "FAILED") {
          render.status = "failed";
          render.error = "fal.ai reported that this render failed. Review your copy before deliberately creating a new paid attempt.";
        } else if (status.status === "COMPLETED") {
          const result = await falVideoResult(render.requestId, credential.key);
          if (!deps.store.saveBinary) throw new Error("Video storage does not support saving files.");
          const folder = await runFolder(deps.store, "video-production", "campaigns", campaign._id, render.id);
          render.fileId = await deps.store.saveBinary(folder, "campaign.mp4", result.content, result.mimeType);
          render.status = "complete";
          delete render.error;
        } else {
          render.status = status.status === "IN_QUEUE" ? "queued" : "processing";
          delete render.error;
        }
      } catch (error) {
        render.error = `Refresh failed; refresh this same attempt again, not a new paid render. ${providerError(error, credential.key)}`;
      }
      return { campaign: publicCampaign(await updateRender(deps, campaign, previousStatus)) };
    }
    throw new Error("Invalid campaign action.");
  });
}
