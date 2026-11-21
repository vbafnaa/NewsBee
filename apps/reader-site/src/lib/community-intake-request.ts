import { CommunityIntakeError, validateCommunityIntake, type IntakeKind } from "../../../../shared/community-intake";
import { directoryTown, readerDatabase } from "./reader-data";
import { saveCommunityIntake } from "./community-intake-storage";

const REQUEST_MAX = 16 * 1024;
async function boundedJson(request: Request): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new CommunityIntakeError("Send the form as JSON.", 415);
  if (Number(request.headers.get("content-length")) > REQUEST_MAX) throw new CommunityIntakeError("This form is too large. Shorten the text and try again.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new CommunityIntakeError("The form is empty.", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > REQUEST_MAX) { await reader.cancel(); throw new CommunityIntakeError("This form is too large. Shorten the text and try again.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new CommunityIntakeError("The form could not be read. Please try again.", 400); }
}

export async function receiveCommunityIntake(kind: IntakeKind, request: Request, url: URL) {
  const headers = { "Cache-Control": "private, no-store" };
  if (request.headers.get("origin") !== url.origin) return Response.json({ detail: "Cross-origin submissions are not allowed." }, { status: 403, headers });
  try {
    const checked = validateCommunityIntake(kind, await boundedJson(request));
    if ("error" in checked) return Response.json({ detail: checked.error }, { status: 422, headers });
    const db = await readerDatabase();
    if (checked.input.location_id) {
      const location = await directoryTown(checked.input.location_id, db);
      if (!location) return Response.json({ detail: "This community could not be found. Choose another community or enter its name." }, { status: 404, headers });
      checked.input.community_name = location.name;
    }
    const receipt = await saveCommunityIntake(db, checked.input);
    return Response.json({ status: "pending_review", receipt }, { status: 201, headers });
  } catch (error) {
    if (error instanceof CommunityIntakeError) return Response.json({ detail: error.message }, { status: error.status, headers: { ...headers, ...(error.status === 429 ? { "Retry-After": "3600" } : {}) } });
    console.error("Community inquiry could not be saved", error instanceof Error ? error.name : "Unknown error");
    return Response.json({ detail: "We could not save your form right now. Your text is still here; please try again." }, { status: 503, headers });
  }
}
