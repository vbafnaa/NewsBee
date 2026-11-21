import type { PublicationDraftSnapshotV1, PublicationReleasePayloadV1 } from "./publication-release";

export type PublicationReaderMetadata = {
  readerBaseUrl: string | null;
  readerLink: { state: "available" } | { state: "unavailable"; detail: string };
};

/** Private transport only: deliberately has no release, approval, or publishing metadata. */
export type PublicationPreview = {
  kind: "publication-draft-preview";
  snapshot: PublicationDraftSnapshotV1;
  publication: PublicationReleasePayloadV1["publication"];
  sponsor_placements: PublicationReleasePayloadV1["sponsor_placements"];
};

export type PublicationPreviewResponse = PublicationPreview & { preview_url: string };

export const PRIVATE_PREVIEW_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  Vary: "Cookie",
};
