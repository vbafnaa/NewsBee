import type { APIRoute } from "astro";
import { readerDatabase } from "../../../lib/reader-data";
import { newsletterConfig, updateNewsletter } from "../../../lib/newsletter";
import { newsletterJson } from "../../../lib/newsletter-http";
import { emailUnavailableResponse } from "../../../../../../shared/email-availability";
export const prerender = false;
export const POST: APIRoute = async ({ request, url }) => {
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  if (request.headers.get("origin") !== url.origin) return Response.json({ detail: "Cross-origin requests are not allowed." }, { status: 403, headers });
  const config = newsletterConfig();
  if (!config) return Response.json({ detail: "Newsletter preferences are temporarily unavailable." }, { status: 503, headers });
  let body: Record<string, unknown>;
  try { body = await newsletterJson(request); } catch { return Response.json({ detail: "Send a valid, bounded JSON object." }, { status: 400, headers }); }
  if (typeof body.id !== "string" || typeof body.token !== "string" || typeof body.action !== "string") return Response.json({ detail: "Open the link from your newsletter email." }, { status: 422, headers });
  if (body.action === "confirm") return emailUnavailableResponse();
  if (body.action === "preferences" && body.consent !== true) return Response.json({ detail: "Confirm that you want to receive weekly editions." }, { status: 422, headers });
  try {
    const result = await updateNewsletter(await readerDatabase(), config, body.id, body.token, body.action, body.topics);
    return Response.json({ status: result.sub.status, manage_url: result.manageUrl,
      detail: body.action === "unsubscribe" ? "You're unsubscribed. No more newsletter emails will be sent for this community." : "Your preferences are saved. Email delivery has not launched; your subscription status is unchanged." }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save preferences.";
    const invalid = /link|topics|action|preferences changed/i.test(message);
    return Response.json({ detail: invalid ? message : "Could not save preferences. Please try again." }, { status: invalid ? 422 : 503, headers });
  }
};
