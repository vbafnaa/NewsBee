import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { Principal } from "../accounts/identity";
import { ExecutionBlocked } from "../core/execution-errors";
import { RunConflict } from "../orchestration/runs";

export const VIDEO_CAMPAIGNS = "newsbee_video_campaigns";
export type CampaignCopy = { title: string; brief: string; script: string; caption: string; prompt: string };
export type CampaignRender = {
  id: string;
  status: "submitting" | "queued" | "processing" | "complete" | "failed";
  requestId?: string;
  credentialVersion: number;
  identityGeneration: string;
  fundingSource: "personal" | "environment";
  prompt: string;
  script: string;
  caption: string;
  createdAt: number;
  fileId?: string;
  error?: string;
};
export type VideoCampaign = CampaignCopy & {
  _id: string;
  createdBy: string;
  revision: number;
  updatedAt: number;
  render?: CampaignRender;
};

export function requireCampaignOperator(principal: Principal) {
  if (principal.role !== "owner" && principal.role !== "admin") throw new ExecutionBlocked("Newsbee operator access required.");
}

export function campaignCopy(input: unknown): CampaignCopy {
  if (!input || typeof input !== "object") throw new Error("Invalid campaign copy.");
  const record = input as Record<string, unknown>;
  const limits = { title: 160, brief: 4000, script: 1200, caption: 2200, prompt: 6000 };
  const output = {} as CampaignCopy;
  for (const key of Object.keys(limits) as Array<keyof CampaignCopy>) {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length > limits[key] || (key === "title" && !value.trim())) {
      throw new Error(`Invalid campaign ${key} (maximum ${limits[key]} characters).`);
    }
    output[key] = value.trim();
  }
  return output;
}

export function campaignPrompt(copy: CampaignCopy) {
  if (!copy.brief || !copy.script || !copy.prompt) throw new Error("Invalid campaign: complete the brief, spoken script and visual direction before rendering.");
  return `Create a 15-second vertical 9:16 promotional video, not a news report.
Use only the supplied claims; do not invent facts, testimonials or endorsements.
Visual direction: ${copy.prompt}
Exact spoken script: ${copy.script}
No additional dialogue, logos or on-screen text.`;
}

export const campaignCollection = (db: Db) => db.collection<VideoCampaign>(VIDEO_CAMPAIGNS);

export async function saveCampaign(db: Db, principal: Principal, input: unknown, id?: unknown, revision?: number) {
  requireCampaignOperator(principal);
  if (id !== undefined && (typeof id !== "string" || !id.trim() || id.length > 100)) {
    throw new Error("Invalid campaign ID.");
  }
  const copy = campaignCopy(input);
  if (id === undefined) {
    const campaign: VideoCampaign = { ...copy, _id: randomUUID(), createdBy: principal.id, revision: 1, updatedAt: Date.now() };
    await campaignCollection(db).insertOne(campaign);
    return campaign;
  }
  if (!Number.isSafeInteger(revision) || revision! < 1) throw new Error("Invalid campaign revision.");
  const campaign = await campaignCollection(db).findOneAndUpdate(
    { _id: id, createdBy: principal.id, revision },
    { $set: { ...copy, updatedAt: Date.now() }, $inc: { revision: 1 } },
    { returnDocument: "after" },
  );
  if (!campaign) throw new RunConflict("Campaign changed or is unavailable. Reload before saving.");
  return campaign;
}

export async function claimCampaignRender(db: Db, campaign: VideoCampaign, render: CampaignRender) {
  const claimed = await campaignCollection(db).findOneAndUpdate({
    _id: campaign._id, createdBy: campaign.createdBy, revision: campaign.revision,
    $or: [{ render: { $exists: false } }, { "render.status": { $in: ["complete", "failed"] } }],
  }, { $set: { render, updatedAt: Date.now() }, $inc: { revision: 1 } }, { returnDocument: "after" });
  if (!claimed) throw new RunConflict("Campaign changed or a render is already active. Reload; do not submit another paid request.");
  return claimed;
}

export function publicCampaign(campaign: VideoCampaign) {
  const { render, ...copy } = campaign;
  return {
    ...copy,
    render: render ? {
      id: render.id, status: render.status, createdAt: render.createdAt, error: render.error,
      script: render.script, caption: render.caption, prompt: render.prompt, fundingSource: render.fundingSource,
      downloadable: render.status === "complete" && Boolean(render.fileId),
    } : undefined,
  };
}
