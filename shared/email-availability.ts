export const EMAIL_UNAVAILABLE = "Email delivery has not launched. Sending, confirmation signup, campaigns, and email previews are unavailable. Existing subscriptions and consent are preserved; signed preference and unsubscribe links remain available.";

/** Product availability, independent of provider credentials. */
export function emailAvailable(): boolean { return false; }

export function emailUnavailableResponse() {
  return Response.json({ detail: EMAIL_UNAVAILABLE }, {
    status: 503,
    headers: { "Cache-Control": "private, no-store" },
  });
}
