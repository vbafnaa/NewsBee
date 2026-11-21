/** Keep return links on this origin and out of authentication loops. */
export function loginDestination(value: unknown, baseUrl?: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || /[\u0000-\u001f\u007f\\]|%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) return "/";
  try {
    const base = new URL(baseUrl ?? "https://newsbee.invalid");
    if (!value.startsWith("/") && !baseUrl) return "/";
    if (value.startsWith("//")) return "/";
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.username || url.password) return "/";
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(path)
      || /^\/(?:login|signup|reset-password)(?:\/|$)/i.test(path)
      || /^\/api(?:\/|$)/i.test(path)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
