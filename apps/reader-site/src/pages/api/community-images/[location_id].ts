import type { APIRoute } from "astro";
import { communityPhoto } from "../../../../../../shared/community-photos";
import { deliverStoryImage } from "../../../lib/image-delivery";

export const prerender = false;

/** Only versioned, reviewed cover images can be fetched; incoming URLs are never used. */
export const GET: APIRoute = async ({ params, request }) => {
  const photo = communityPhoto(params.location_id);
  if (!photo) return new Response(null, { status: 404 });
  try {
    const image = await deliverStoryImage(photo.image);
    const headers = { "Content-Type": image.contentType,
      "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin", ETag: image.etag };
    if (request.headers.get("if-none-match") === image.etag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(image.bytes), { headers: { ...headers, "Content-Length": String(image.bytes.byteLength) } });
  } catch { return new Response(null, { status: 502, headers: { "Cache-Control": "no-store" } }); }
};
