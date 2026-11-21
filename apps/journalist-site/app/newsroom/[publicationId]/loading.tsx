import { NewsroomPageSkeleton } from "./page-skeleton";

/**
 * Shown the moment a journalist clicks between newsroom pages, while the next page's server data
 * loads. It also lets Next prefetch every sidebar link up to this point, so the page changes at once.
 */
export default function NewsroomRouteLoading() {
  return <>
    <div className="jw-route-loading" role="status" aria-live="polite"><span className="visually-hidden">Loading page…</span></div>
    <NewsroomPageSkeleton />
  </>;
}
