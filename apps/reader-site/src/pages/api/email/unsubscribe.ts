import type { APIRoute } from "astro";
import {
  PublicationEmailTokenError,
  unsubscribePublicationEmail,
} from "../../../lib/publication-email-storage";
import { newsletterJson } from "../../../lib/newsletter-http";
import { readerDatabase } from "../../../lib/reader-data";

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ detail: "Cross-origin unsubscribe requests are not allowed." }, { status: 403 });
  }
  const body = await newsletterJson(request).catch(() => null);
  if (!body) {
    return Response.json({ detail: "Request body must be a JSON object." }, { status: 400 });
  }
  try {
    await unsubscribePublicationEmail(await readerDatabase(), String(body.token ?? ""));
    return Response.json({ status: "unsubscribed" }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof PublicationEmailTokenError) {
      return Response.json({ detail: error.message }, { status: 400 });
    }
    console.error("Publication email unsubscribe could not be saved", error instanceof Error ? error.message : "unknown error");
    return Response.json({ detail: "Unsubscribe could not be saved. Please try again." }, { status: 503 });
  }
};
