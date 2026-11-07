const SECRET_FIELD = /^(authorization|cookie|set-cookie|password|secret|token|access_token|refresh_token|id_token|ciphertext)$|api.?key$|private.?key$/i;
const SECRET_QUERY = /^(key|api[_-]?key|token|access_token|auth|authorization|secret|password|signature|x-amz-signature|x-goog-signature)$/i;

function safeLinks(value: string) {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const parsed = new URL(url);
      let changed = Boolean(parsed.username || parsed.password);
      parsed.username = ""; parsed.password = "";
      for (const key of [...parsed.searchParams.keys()]) if (SECRET_QUERY.test(key)) { parsed.searchParams.delete(key); changed = true; }
      return changed ? parsed.toString() : url;
    } catch { return url; }
  });
}

/** Provider response bodies are untrusted and may echo request credentials. */
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(Model request (?:failed|rate limited))/.test(message)) return message.split(":")[0];
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch { return "[redacted URL]"; }
    })
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 400);
}

export function redact(value: unknown, key = ""): unknown {
  if (SECRET_FIELD.test(key)) return "[redacted]";
  if (value instanceof Error) return safeError(value);
  if (typeof value === "string") value = safeLinks(value);
  if (typeof value === "string") return /error|detail|reason/i.test(key) ? safeError(value) : value.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}
