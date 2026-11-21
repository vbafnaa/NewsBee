import type { APIRoute } from "astro";
import {
  PublicationEmailTokenError,
  PublicationEmailValidationError,
  publicationEmailSubscriptionForToken,
  updatePublicationEmailPreferences,
} from "../../../lib/publication-email-storage";
import { newsletterJson } from "../../../lib/newsletter-http";
import { loadReaderPublication, readerDatabase } from "../../../lib/reader-data";
import { emailUnavailableResponse } from "../../../../../../shared/email-availability";

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ detail: "Cross-origin preference requests are not allowed." }, { status: 403 });
  }
  const body = await newsletterJson(request).catch(() => null);
  if (!body) {
    return Response.json({ detail: "Request body must be a JSON object." }, { status: 400 });
  }
  if (body.action === "confirm") return emailUnavailableResponse();
  try {
    const token = String(body.token ?? "");
    const db = await readerDatabase();
    const action = String(body.action ?? "preferences");
    if (action !== "preferences") {
      return Response.json({ detail: "Choose a valid email preference action." }, { status: 400 });
    }
    const subscription = await publicationEmailSubscriptionForToken(db, token);
    const loaded = await loadReaderPublication(subscription.publication_id, null, db);
    if (!loaded) return Response.json({ detail: "This publication is not currently available." }, { status: 404 });
    const updated = await updatePublicationEmailPreferences(
      db,
      token,
      body.location_ids,
      loaded.release.locations.map((location) => location.id),
    );
    return Response.json({ status: "saved", location_ids: updated.location_ids }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof PublicationEmailValidationError) {
      return Response.json({ detail: error.message }, { status: 422 });
    }
    if (error instanceof PublicationEmailTokenError) {
      return Response.json({ detail: error.message }, { status: 400 });
    }
    console.error("Publication email preferences could not be saved", error instanceof Error ? error.message : "unknown error");
    return Response.json({ detail: "Preferences could not be saved. Please try again." }, { status: 503 });
  }
};
