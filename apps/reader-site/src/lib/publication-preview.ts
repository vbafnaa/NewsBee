import type { PublicationPreview } from "../../../../shared/publication-preview";

export class PreviewUnavailable extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function bridgeOrigin(request: Request) {
  const incoming = new URL(request.url);
  if (process.env.NEWSBEE_MODE === "local" && !process.env.VERCEL && process.env.NODE_ENV !== "production"
    && ["localhost", "127.0.0.1", "[::1]"].includes(incoming.hostname) && process.env.AUTH_URL) {
    const configured = new URL(process.env.AUTH_URL);
    if (configured.hostname === incoming.hostname && configured.protocol === incoming.protocol
      && !configured.username && !configured.password) return configured.origin;
  }
  return incoming.origin;
}

export async function fetchPublicationPreviewResponse(
  request: Request,
  publicationId: string,
  draftId: string,
  revision: string | null,
  fetcher: typeof fetch = fetch,
  media?: { image: string; width: string; layout: string },
): Promise<Response> {
  if (!revision || !/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) {
    throw new PreviewUnavailable(422, "Select an exact draft revision to preview.");
  }
  const url = new URL(`/api/admin/publications/${encodeURIComponent(publicationId)}/drafts/${encodeURIComponent(draftId)}/preview`, bridgeOrigin(request));
  url.searchParams.set("revision", revision);
  if (media) for (const [key, value] of Object.entries(media)) url.searchParams.set(key, value);
  return fetcher(url, {
    headers: { cookie: request.headers.get("cookie") ?? "", accept: media ? "image/*" : "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
}

/** The incoming, same-host journalist session is the only preview credential. No reusable preview token. */
export async function fetchPublicationPreview(
  request: Request,
  publicationId: string,
  draftId: string,
  revision: string | null,
  fetcher: typeof fetch = fetch,
): Promise<PublicationPreview> {
  const response = await fetchPublicationPreviewResponse(request, publicationId, draftId, revision, fetcher);
  if (!response.ok) {
    const status = [401, 403, 404, 409, 422].includes(response.status) ? response.status : 503;
    const messages: Record<number, string> = {
      401: "Sign in to the journalist workspace to preview this draft.",
      403: "You no longer have permission to preview this publication.",
      404: "The selected publication draft is unavailable.",
      409: "The draft changed or is no longer available. Reload the editorial workspace.",
      422: "The selected draft cannot be rendered. Review its included stories and media in the editorial workspace.",
      503: "Draft preview is temporarily unavailable.",
    };
    throw new PreviewUnavailable(status, messages[status]);
  }
  const result = await response.json() as PublicationPreview;
  if (result.kind !== "publication-draft-preview" || result.publication?.id !== publicationId
    || result.snapshot?.draft_id !== draftId || result.snapshot.draft_revision !== Number(revision)) {
    throw new PreviewUnavailable(409, "The preview did not match the selected draft revision.");
  }
  return result;
}
