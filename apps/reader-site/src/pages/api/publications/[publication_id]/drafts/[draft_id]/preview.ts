import type { APIRoute } from "astro";
import { PRIVATE_PREVIEW_HEADERS } from "../../../../../../../../../shared/publication-preview";
import { fetchPublicationPreviewResponse, PreviewUnavailable } from "../../../../../../lib/publication-preview";

export const prerender = false;

/** Private media only; the journalist endpoint reauthorizes the exact draft and selected story. */
export const GET: APIRoute = async ({ request, params, url }) => {
  try {
    const image = url.searchParams.get("image");
    const width = url.searchParams.get("width") ?? "1200";
    const layout = url.searchParams.get("layout") ?? "desktop";
    if (url.searchParams.getAll("revision").length !== 1 || url.searchParams.getAll("image").length !== 1
      || !image || image.length > 256 || !["480", "960", "1200", "1800", "2400"].includes(width)
      || !["desktop", "mobile"].includes(layout)) {
      return new Response(null, { status: 422, headers: PRIVATE_PREVIEW_HEADERS });
    }
    const response = await fetchPublicationPreviewResponse(
      request, params.publication_id!, params.draft_id!, url.searchParams.get("revision"), fetch,
      { image, width, layout },
    );
    if (!response.ok) return new Response(null, {
      status: [401, 403, 404, 409, 422].includes(response.status) ? response.status : 503,
      headers: PRIVATE_PREVIEW_HEADERS,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(contentType)) {
      return new Response(null, { status: 503, headers: PRIVATE_PREVIEW_HEADERS });
    }
    return new Response(response.body, { headers: {
      ...PRIVATE_PREVIEW_HEADERS, "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch (error) {
    return new Response(null, {
      status: error instanceof PreviewUnavailable ? error.status : 503, headers: PRIVATE_PREVIEW_HEADERS,
    });
  }
};
