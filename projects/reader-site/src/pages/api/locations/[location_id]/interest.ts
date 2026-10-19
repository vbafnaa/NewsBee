import type { APIRoute } from "astro";
import { readerData, saveInterestSignup } from "../../../../lib/reader-data";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ detail: "Cross-origin signup requests are not allowed" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
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

  try {
    const { locations } = await readerData();
    const location = locations.find((item) => item.id === params.location_id);
    if (!location) return Response.json({ detail: "Unknown location" }, { status: 404 });
    await saveInterestSignup(location, email.trim().toLowerCase());
    return Response.json({ status: "saved" });
  } catch (error) {
    console.error("Reader interest signup could not be saved", error);
    return Response.json({ detail: "Signup could not be saved. Please try again." }, { status: 503 });
  }
};
