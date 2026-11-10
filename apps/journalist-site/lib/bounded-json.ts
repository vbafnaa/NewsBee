/** Bound streamed bodies even when the caller omits or understates Content-Length. */
export async function boundedJson(request: Request, limit = 64 * 1024): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw Error("Invalid request: missing JSON body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw Error("Invalid request: JSON body is too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw Error("Invalid request: malformed JSON"); }
}
