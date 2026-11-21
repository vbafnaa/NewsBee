import { randomUUID } from "node:crypto";
import type { APIRoute } from "astro";
import { readerData, readerDatabase } from "../../lib/reader-data";
import { BeeError, beeIdentity, beeIndexes, beeState, consentBeeResult, guessBeeLetter, startBeeAttempt } from "../../../../journalist-site/pipeline/games/save-the-bee";
import { publicationBeeAccess } from "../../lib/publication-bee";
import { PreviewUnavailable } from "../../lib/publication-preview";

export const prerender = false;
const ID = /^[A-Za-z0-9:_-]{1,120}$/;
const COOKIE = "newsbee-bee";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

const route: APIRoute = async ({ request, url, cookies }) => {
  if (request.method === "POST" && request.headers.get("origin") !== url.origin) {
    return Response.json({ detail: "Cross-origin requests are not allowed." }, { status: 403, headers });
  }
  try {
    const location = url.searchParams.get("location") ?? "";
    const edition = url.searchParams.get("edition") ?? "";
    const publication = url.searchParams.get("publication");
    const release = url.searchParams.get("release") ?? "";
    const draft = url.searchParams.get("draft");
    const preview = publication && draft ? { draftId: draft, revision: url.searchParams.get("revision") } : undefined;
    if (publication) {
      if (!ID.test(publication) || (preview ? !ID.test(preview.draftId) || Boolean(release) : !ID.test(release))
        || location || edition) throw new BeeError("Invalid publication game.", 422);
    } else {
      if (!ID.test(location) || !ID.test(edition) || draft || release) throw new BeeError("Invalid edition.", 422);
      // Match the actual published reader directory, including removed locations.
      const data = await readerData(undefined, { locationId: location, editionId: edition });
      if (!data.editions.some(e => e.id === edition && e.location_id === location)) throw new BeeError("Unknown reader edition.", 404);
    }
    const access = publication ? publicationBeeAccess(request, publication, release, preview) : undefined;
    if (access) await access(Date.now());
    let token = cookies.get(COOKIE)?.value;
    if (!token || !UUID.test(token)) {
      if (request.method === "POST") throw new BeeError("Reload the game to establish this browser's save cookie.", 409);
      token = randomUUID();
      cookies.set(COOKIE, token, { httpOnly: true, secure: url.protocol === "https:", sameSite: "lax",
        path: "/reader", maxAge: 365 * 86400 });
    }
    const db = await readerDatabase();
    await beeIndexes(db);
    const owner = beeIdentity(token);
    const state = () => beeState(db, location, edition, owner, Date.now(), access);
    if (request.method === "GET") return Response.json(await state(), { headers });
    if (Number(request.headers.get("content-length") ?? 0) > 2048) throw new BeeError("Request is too large.", 413);
    const text = await request.text();
    if (text.length > 2048) throw new BeeError("Request is too large.", 413);
    let input: Record<string, unknown>;
    try { input = JSON.parse(text); }
    catch { throw new BeeError("Request body must be valid JSON.", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new BeeError("Invalid game request.", 422);
    const bucket = Math.floor(Date.now() / 60_000);
    const limits = db.collection<{ _id: string; count: number; expiresAt: Date }>("bee_request_limits");
    const counter = await limits.findOneAndUpdate({ _id: `${owner}:${bucket}` },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 86400_000) } }, { upsert: true, returnDocument: "after" });
    if (counter!.count > 120) throw new BeeError("Give the hive a moment. Please try again in a minute.", 429);
    let attempt;
    if (input.action === "start" && (input.practice === undefined || input.practice === false)) {
      attempt = await startBeeAttempt(db, location, edition, owner, false, undefined, access);
    } else if (input.action === "guess" && typeof input.attemptId === "string" && typeof input.letter === "string") {
      attempt = await guessBeeLetter(db, location, edition, owner, input.attemptId, input.letter, undefined, access);
    } else if (input.action === "consent" && typeof input.public === "boolean" && typeof input.shoutout === "boolean" &&
      (typeof input.nickname === "string" || input.nickname === null)) {
      if (preview) throw new BeeError("Sharing preview results is unavailable.", 422);
      attempt = await consentBeeResult(db, location, edition, owner, {
        public: input.public, shoutout: input.shoutout, nickname: input.nickname,
      }, access);
    } else throw new BeeError("Invalid game action.", 422);
    return Response.json({ attempt, ...await state() }, { headers });
  } catch (error) {
    if (error instanceof BeeError) return Response.json({ detail: error.message }, { status: error.status, headers });
    if (error instanceof PreviewUnavailable) return Response.json({ detail: error.message }, { status: error.status, headers });
    console.error("Guide the Bee Home request failed", error);
    return Response.json({ detail: "The hive could not save this request. Retry safely; your saved guesses are kept." }, { status: 503, headers });
  }
};
export const GET = route;
export const POST = route;
