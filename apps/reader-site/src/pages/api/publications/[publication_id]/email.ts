import type { APIRoute } from "astro";
import { emailUnavailableResponse } from "../../../../../../../shared/email-availability";

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ detail: "Cross-origin signup requests are not allowed." }, { status: 403 });
  }
  return emailUnavailableResponse();
};
