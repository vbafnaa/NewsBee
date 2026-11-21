/** Bound streamed JSON as well as Content-Length; never buffer an unlimited public request. */
export async function newsletterJson(request: Request, limit = 8192): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > limit) throw new Error("Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Send a JSON object.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Request is too large."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Send valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Send a JSON object.");
  return value as Record<string, unknown>;
}
