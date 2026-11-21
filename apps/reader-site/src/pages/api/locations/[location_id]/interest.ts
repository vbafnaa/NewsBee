import type { APIRoute } from "astro";
import { directoryTown, readerDatabase, saveInterestSignup } from "../../../../lib/reader-data";
import { requestNewsletter, validateNewsletterSignup } from "../../../../lib/newsletter";
import { newsletterJson } from "../../../../lib/newsletter-http";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ detail: "Cross-origin signup requests are not allowed" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await newsletterJson(request);
  } catch {
    return Response.json({ detail: "Request body must be valid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ detail: "Request body must be a JSON object" }, { status: 400 });
  }
  const email = (body as Record<string, unknown>).email;
  if (
    typeof email !== "string" ||
    email.trim().length > 254 ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email.trim())
  ) {
    return Response.json({ detail: "Enter a valid email address" }, { status: 422 });
  }
  if ((body as Record<string, unknown>).consent !== true) {
    return Response.json({ detail: "Consent to future weekly editions is required" }, { status: 422 });
  }
  const launchNotification = (body as Record<string, unknown>).launch_notification;
  if (launchNotification !== undefined && typeof launchNotification !== "boolean") {
    return Response.json({ detail: "Launch notification preference must be a boolean" }, { status: 422 });
  }
  let input: ReturnType<typeof validateNewsletterSignup>;
  try { input = validateNewsletterSignup(body); }
  catch (error) { return Response.json({ detail: error instanceof Error ? error.message : "Invalid preferences" }, { status: 422 }); }

  try {
    const location = await directoryTown(params.location_id ?? "");
    if (!location) return Response.json({ detail: "Unknown location" }, { status: 404 });
    await saveInterestSignup(location, email.trim().toLowerCase(), launchNotification === true);
    await requestNewsletter(await readerDatabase(), location, input, null);
    return Response.json({ status: "saved", confirmation_required: false,
      detail: "Your community preferences are saved. Email delivery has not launched; no confirmation email was sent. Browse published editions online." });
  } catch (error) {
    console.error("Reader interest signup could not be saved", error);
    if (error instanceof Error && error.message.startsWith("Too many newsletter")) return Response.json({ detail: error.message }, { status: 429, headers: { "Retry-After": "3600" } });
    return Response.json({ detail: "Signup could not be saved. Please try again." }, { status: 503 });
  }
};
