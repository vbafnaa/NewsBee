import type { HttpTransport } from "../core/http";
import { safeImageUrl } from "../../../../shared/story-image";
import type { EventFacts } from "../connectors/common";
import type { SourceType } from "../connectors/types";

export type SourceAccessReview = {
  inventory_ids: string[];
  decision: string;
  collection_allowed: boolean;
  reason: string;
  evidence: string[];
  checked_on: string;
  expires_on: string;
  images_allowed: boolean;
  allowed_urls: string[];
  collection_params: Record<string, unknown>;
  collection_reader: SourceType;
  inherited_from?: string;
};

type ReviewScope = { source_id: string; name: string; reader: SourceType; url?: string | null; feed_url?: string | null;
  params?: Record<string, unknown>; access_review?: SourceAccessReview };
function endpoint(value: unknown) {
  if (typeof value !== "string") return "";
  try { const url = new URL(value); return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`; }
  catch { return ""; }
}
function urls(source: ReviewScope) {
  return [source.url, source.feed_url, source.params?.url, source.params?.feed_url, source.params?.reviewed_feed_url,
    source.access_review?.collection_params.url, source.access_review?.collection_params.feed_url, source.access_review?.collection_params.reviewed_feed_url,
    ...(source.access_review?.allowed_urls ?? [])].filter((value): value is string => typeof value === "string");
}
const portal = (host: string) => host === "cos-data.seattle.gov" ? "data.seattle.gov" : host;

/** Feed IDs and alternate adapters must not turn a reviewed endpoint into a new approval. */
export function inheritedAccessReview(source: ReviewScope, reviewed: ReviewScope[]): SourceAccessReview | undefined {
  if (source.access_review) return undefined;
  const targets = new Set(urls(source).map(endpoint).filter(Boolean));
  for (const parent of reviewed) {
    const review = parent.access_review;
    if (!review || parent.source_id === source.source_id) continue;
    let matches = source.reader === "web" && urls(parent).some((url) => targets.has(endpoint(url)));
    if (source.reader === "opendata" && typeof source.params?.dataset === "string" && typeof source.params.domain === "string") {
      matches = urls(parent).some((raw) => { try { const url = new URL(raw);
        return portal(url.hostname) === portal(String(source.params?.domain))
          && url.pathname.split("/").map((part) => part.replace(/\.(?:json|csv)$/, "")).includes(String(source.params?.dataset));
      } catch { return false; } });
    }
    if (matches) return { ...review, inventory_ids: [...review.inventory_ids], evidence: [...review.evidence],
      inherited_from: parent.source_id, decision: review.collection_allowed ? "permission_required" : review.decision,
      collection_allowed: false, images_allowed: false, allowed_urls: [], collection_reader: source.reader,
      collection_params: source.params ?? {},
      reason: `Alternate URL or reader for reviewed source ${parent.name}. Separate access approval is required. ${review.reason}` };
  }
  return undefined;
}

export function reviewAllowsCollection(review: SourceAccessReview | undefined, today: string) {
  return !review || (review.collection_allowed && review.checked_on <= today && review.expires_on >= today);
}

/** An approved feed grants access to that feed and robots file, not arbitrary article pages. */
export function reviewedSourceTransport(transport: HttpTransport, review?: SourceAccessReview): HttpTransport {
  if (!review) return transport;
  return async (request) => {
    const today = new Date().toISOString().slice(0, 10);
    if (!reviewAllowsCollection(review, today)) throw new Error(`Source access review prevents collection: ${review.reason}`);
    if (review.allowed_urls.length) {
      const url = safeImageUrl(request.url);
      const allowed = review.allowed_urls.some((item) => url === item || url === `${new URL(item).origin}/robots.txt`);
      if (!allowed) throw new Error("Source access review permits only the reviewed feed URL; other paths require review");
    }
    return transport(request);
  };
}

/** API/feed approval does not authorize a second crawl of linked pages or their photos. */
export function applyReviewedContentPolicy(events: EventFacts[], review?: SourceAccessReview) {
  if (!review) return;
  for (const event of events) {
    event.no_page_fetch = true;
    if (!review.images_allowed) {
      event.image_blocked = true;
      if (event.details && typeof event.details === "object") {
        const details = { ...event.details as Record<string, unknown> };
        for (const field of Object.keys(details)) if (field === "image" || field.startsWith("image_")) delete details[field];
        event.details = details;
      }
    }
  }
}
