import { boundedJson } from "@/lib/bounded-json";
import { sameOrigin } from "@/lib/admin-session";
import { getDatabase } from "@/pipeline/storage/mongo";
import { publicPhotoInvite, submitPhotoSupply } from "@/pipeline/images/supply";

type Context = { params: Promise<{ token: string }> };
export const dynamic = "force-dynamic";
async function handle(request: Request, context: Context) {
  if (request.method === "POST" && !sameOrigin(request)) return Response.json({ detail: "Submit from the photo invitation page." }, { status: 403 });
  const { token } = await context.params;
  if (!/^[a-f0-9]{64}$/.test(token)) return Response.json({ detail: "Photo invitation unavailable." }, { status: 404 });
  try {
    const db = await getDatabase();
    const invitation = await publicPhotoInvite(db, token);
    if (!invitation) return Response.json({ detail: "Photo invitation expired or unavailable." }, { status: 404 });
    return Response.json(request.method === "GET" ? invitation : await submitPhotoSupply(db, token, await boundedJson(request)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return Response.json({ detail: message.startsWith("Invalid ") ? message : "Photo submission is temporarily unavailable." },
      { status: message.startsWith("Invalid ") ? 400 : 500 });
  }
}
async function respond(request: Request, context: Context) {
  const response = await handle(request, context);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
export const GET = respond;
export const POST = respond;
