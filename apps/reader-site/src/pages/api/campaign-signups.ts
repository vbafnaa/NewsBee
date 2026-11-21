import { createHash } from "node:crypto";
import type { APIRoute } from "astro";
import { campaignAttributionKeys, campaigns, isCampaignSlug } from "../../lib/campaigns";
import { readerDatabase } from "../../lib/reader-data";

export const POST: APIRoute = async ({ request, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ detail: "Use the Newsbee campaign form to sign up." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    const data: unknown = await request.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    body = data as Record<string, unknown>;
  } catch {
    return Response.json({ detail: "Invalid signup request." }, { status: 400 });
  }

  const { campaign, role, interest } = body;
  if (!isCampaignSlug(campaign)) {
    return Response.json({ detail: "Unknown campaign." }, { status: 404 });
  }
  const { roles, interests } = campaigns[campaign];
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const context = typeof body.context === "string" ? body.context.trim() : "";
  if (
    email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ||
    !context || context.length > 120 ||
    typeof role !== "string" || !roles.includes(role) ||
    typeof interest !== "string" || !interests.includes(interest) ||
    (campaign === "high-school-journalism" && body.adultAdviser !== true)
  ) {
    return Response.json({ detail: "Check your email and complete the required fields." }, { status: 422 });
  }

  const attribution: Record<string, string> = {};
  for (const key of campaignAttributionKeys) {
    const value = body[key];
    if (typeof value === "string" && /^[a-z0-9][a-z0-9_. -]{0,99}$/i.test(value)) {
      attribution[key] = value;
    }
  }
  const _id = createHash("sha256").update(`${campaign}:${email}`).digest("hex");

  try {
    const signups = (await readerDatabase()).collection<{ _id: string }>("campaign_signups");
    const result = await signups.updateOne(
      { _id },
      { $setOnInsert: { campaign, email, context, role, interest, attribution, createdAt: new Date() } },
      { upsert: true },
    );
    return Response.json({ created: result.upsertedCount === 1 });
  } catch {
    console.error("Could not save Newsbee campaign signup");
    return Response.json({ detail: "We couldn’t save your signup. Please try again." }, { status: 503 });
  }
};
