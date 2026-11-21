import { timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { emailUnavailableResponse } from "../../../../../../shared/email-availability";
export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  const headers = { "Cache-Control": "private, no-store" };
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ detail: "Unauthorized" }, { status: 401, headers });
  return emailUnavailableResponse();
};
