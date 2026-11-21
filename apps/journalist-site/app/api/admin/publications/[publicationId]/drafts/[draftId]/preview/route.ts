import { currentPrincipal } from "@/lib/admin-session";
import { getDatabase } from "@/pipeline/storage/mongo";
import { loadPublicationPreview, previewRevision, publicationPreviewUrl, PublicationReaderConfigurationError } from "@/pipeline/publications/preview";
import { PublicationAccessDenied } from "@/pipeline/publications/permissions";
import {
  PublicationReleaseConflict,
  PublicationReleaseNotFound,
  PublicationReleaseValidationError,
} from "@/pipeline/publications/releases";
import { PRIVATE_PREVIEW_HEADERS, type PublicationPreviewResponse } from "../../../../../../../../../../shared/publication-preview";
import { PHOTO_ASSETS, readPhotoAsset, type PhotoAsset, type PhotoBlob } from "../../../../../../../../../../shared/image-assets";
import { downloadStoryImage } from "../../../../../../../../../../shared/image-validation";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ publicationId: string; draftId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const principal = await currentPrincipal();
    if (!principal) return Response.json({ detail: "Sign in to preview this draft." }, { status: 401, headers: PRIVATE_PREVIEW_HEADERS });
    const { publicationId, draftId } = await context.params;
    const url = new URL(request.url);
    if (url.searchParams.getAll("revision").length !== 1 || url.searchParams.getAll("image").length > 1) {
      throw new PublicationReleaseValidationError("Select one exact draft revision to preview.");
    }
    const revision = previewRevision(url.searchParams.get("revision"));
    const db = await getDatabase();
    const result = await loadPublicationPreview(db, principal, publicationId, draftId, revision);
    const previewUrl = publicationPreviewUrl(publicationId, draftId, revision);
    const imageId = url.searchParams.get("image");
    if (imageId !== null) {
      const item = result.snapshot.items.find((candidate) => candidate.item_id === imageId);
      if (!item?.image) return new Response(null, { status: 404, headers: PRIVATE_PREVIEW_HEADERS });
      const width = Number(url.searchParams.get("width") ?? 1200);
      if (![480, 960, 1200, 1800, 2400].includes(width)) {
        return new Response(null, { status: 422, headers: PRIVATE_PREVIEW_HEADERS });
      }
      const image = item.image_asset_id ? await readPhotoAsset({
        asset: (id) => db.collection<PhotoAsset>(PHOTO_ASSETS).findOne({ _id: id }),
        blob: (id) => db.collection<PhotoBlob>(`${PHOTO_ASSETS}_blobs`).findOne({ _id: id }),
      }, item.image_asset_id, width, url.searchParams.get("layout") === "mobile" ? "mobile" : "desktop")
        : await downloadStoryImage(item.image);
      return new Response(new Uint8Array(image.bytes), { headers: {
        ...PRIVATE_PREVIEW_HEADERS, "Content-Type": image.contentType,
        "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      } });
    }
    return Response.json({
      ...result, preview_url: previewUrl,
    } satisfies PublicationPreviewResponse, { headers: PRIVATE_PREVIEW_HEADERS });
  } catch (error) {
    const status = error instanceof PublicationAccessDenied ? 403
      : error instanceof PublicationReleaseNotFound ? 404
      : error instanceof PublicationReleaseConflict ? 409
      : error instanceof PublicationReleaseValidationError ? 422 : 503;
    return Response.json({
      detail: error instanceof PublicationReaderConfigurationError ? error.message
        : status === 503 ? "Draft preview is temporarily unavailable." : (error as Error).message,
    }, { status, headers: PRIVATE_PREVIEW_HEADERS });
  }
}
