import { InputError } from "./validation";

export async function jsonRequest(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new InputError("Content-Type must be application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("JSON body is required");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new InputError(`JSON body exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new InputError("Invalid JSON body"); }
}

export function apiError(error: unknown): Response {
  if (error instanceof InputError) return Response.json({ error: error.message }, { status: 400 });
  if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
    return Response.json({ error: "A matching record already exists" }, { status: 409 });
  }
  if (error instanceof Error && error.message === "MONGODB_URI is not configured") {
    return Response.json({ error: "Database is not configured" }, { status: 503 });
  }
  console.error("Muse receiver request failed", error);
  return Response.json({ error: "Server error" }, { status: 500 });
}
