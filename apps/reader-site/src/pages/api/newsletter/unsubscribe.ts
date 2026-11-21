import type { APIRoute } from "astro";
import { readerDatabase } from "../../../lib/reader-data";
import { newsletterConfig, updateNewsletter } from "../../../lib/newsletter";
export const prerender = false;
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
/** GET is read-only: email link scanners must never unsubscribe a reader. */
export const GET: APIRoute = async ({ url, redirect }) => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const response = redirect(`${base}/newsletter?${new URLSearchParams({ id: url.searchParams.get("id") ?? "", token: url.searchParams.get("token") ?? "" })}`, 303);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
};
/** RFC 8058 one-click POSTs authenticate with the signed URL rather than a browser origin. */
export const POST: APIRoute = async ({ url }) => {
  const config = newsletterConfig();
  if (!config) return Response.json({ detail: "Newsletter preferences are temporarily unavailable." }, { status: 503, headers });
  try {
    await updateNewsletter(await readerDatabase(), config, url.searchParams.get("id") ?? "", url.searchParams.get("token") ?? "", "unsubscribe");
    return Response.json({ status: "unsubscribed" }, { headers });
  } catch { return Response.json({ detail: "Invalid unsubscribe link." }, { status: 422, headers }); }
};
