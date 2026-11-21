import { randomUUID } from "node:crypto";
import type { APIRoute } from "astro";
import { articleKey } from "../../lib/edition-view";
import type { Db } from "mongodb";
import { withSiteWriter } from "../../../../../shared/restore-maintenance";
import { loadReaderPublication, readerData, readerDatabase } from "../../lib/reader-data";
import { commentInput, readStoryConversation, saveStoryComment, saveStoryFeedback, storyReference, StoryConversationError, type StoryReference } from "../../lib/story-conversation";

export const prerender = false;
const REQUEST_MAX = 12 * 1024;
const COOKIE = "newsbee_conversation";

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new StoryConversationError("Send your response as JSON.", 415);
  if (Number(request.headers.get("content-length")) > REQUEST_MAX) throw new StoryConversationError("This response is too long.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new StoryConversationError("Write a response first.", 400);
  const parts: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > REQUEST_MAX) { await reader.cancel(); throw new StoryConversationError("This response is too long.", 413); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new StoryConversationError("Your response could not be read. Please try again.", 400); }
}

async function validatePublishedStory(story: StoryReference, db: Db) {
  if ("publication_id" in story) {
    const published = await loadReaderPublication(story.publication_id, story.release_id, db);
    if (!published || published.entry.withdrawn || !published.release.items.some((item) => item.item_id === story.story_id)) {
      throw new StoryConversationError("This published story could not be found.", 404);
    }
    return;
  }
  const { editions } = await readerData(undefined, { locationId: story.location_id, editionId: story.edition_id });
  const edition = editions.find((item) => item.id === story.edition_id && item.location_id === story.location_id);
  if (!edition?.items.some((item, index) => articleKey(item, index) === story.story_id)) {
    throw new StoryConversationError("This published story could not be found.", 404);
  }
}

const handle: APIRoute = async (context) => {
  const { request, url } = context;
  const headers = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  if (request.method === "POST" && request.headers.get("origin") !== url.origin) return Response.json({ detail: "Cross-origin submissions are not allowed." }, { status: 403, headers });
  const existing = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const visitor = existing && /^[a-f0-9-]{36}$/i.test(existing) ? existing : randomUUID();
  if (visitor !== existing) headers.append("Set-Cookie", `${COOKIE}=${visitor}; Path=/reader; Max-Age=31536000; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`);
  try {
    const body = request.method === "POST" ? await boundedJson(request) : Object.fromEntries(url.searchParams);
    const story = storyReference(body);
    let action: "comment" | "feedback" | undefined;
    let comment: ReturnType<typeof commentInput> | undefined;
    if (request.method === "POST") {
      if (body.action !== "comment" && body.action !== "feedback") throw new StoryConversationError("Choose a comment or feedback response.");
      action = body.action;
      if (action === "comment") comment = commentInput(body);
      if (action === "feedback" && typeof body.useful !== "boolean") throw new StoryConversationError("Choose Yes, helpful or Needs work.");
    }
    const db = await readerDatabase();
    const respond = async () => {
      await validatePublishedStory(story, db);
      if (action === "comment") await saveStoryComment(db, story, comment!, visitor, context.clientAddress || "unknown");
      if (action === "feedback") await saveStoryFeedback(db, story, body.useful as boolean, visitor, context.clientAddress || "unknown");
      return Response.json(await readStoryConversation(db, story, visitor), { status: action === "comment" ? 201 : 200, headers });
    };
    return await (action ? withSiteWriter(db, respond) : respond());
  } catch (error) {
    if (error instanceof StoryConversationError) {
      if (error.status === 429) headers.set("Retry-After", "3600");
      return Response.json({ detail: error.message }, { status: error.status, headers });
    }
    console.error("Story conversation unavailable", error instanceof Error ? error.name : "Unknown error");
    return Response.json({ detail: "We could not load or save this response right now. Please try again." }, { status: 503, headers });
  }
};
export const GET = handle;
export const POST = handle;
