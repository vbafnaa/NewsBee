import Link from "next/link";
import { newsroomHref, sourceMapHref } from "../../newsroom-routes";
import { Icon, PageHeader } from "../../newsroom-ui";
import { loadNewsroom, newsroomCommunities } from "../newsroom-context";
import NewsroomSourceMap from "./newsroom-source-map";

/**
 * Source map (frame 06): the shared sources of the communities this newsroom covers. Journalists can review,
 * add, accept and reject sources and review or start collection runs; every check is repeated on the server.
 */
export default async function NewsroomSourceMapPage({ params, searchParams }: {
  params: Promise<{ publicationId: string }>;
  searchParams: Promise<{ location?: string; tab?: string; run?: string }>;
}) {
  const { publicationId } = await params;
  const query = await searchParams;
  const { principal, db, publication } = await loadNewsroom(publicationId);
  const communities = await newsroomCommunities(db, publication.selectedLocationIds);
  const requested = communities.find((community) => community.id === query.location);
  const community = requested ?? communities[0];
  return <section className="jw-source-map" aria-labelledby="source-map-title">
    <PageHeader eyebrow="Current" title="Source map" titleId="source-map-title"
      description={community ? `Sources collected and monitored for ${community.name}.` : `Sources for the communities ${publication.name} covers.`}
      actions={community && <Link className="jw-button" href={`${sourceMapHref(publicationId, community.id)}#add-source`}><Icon name="map" size={16} />Add source</Link>} />
    {query.location && !requested && <p className="alert" role="alert">That community isn&apos;t covered by {publication.name}. Showing {community?.name ?? "the newsroom's coverage"} instead.</p>}
    {!community
      ? <div className="jw-card jw-empty"><p>{publication.name} doesn&apos;t cover any communities yet. Coverage is set in Settings.</p>
        <Link className="jw-button" href={`${newsroomHref(publicationId, "settings")}#audience`}>Coverage settings</Link></div>
      : <NewsroomSourceMap publicationId={publicationId} communities={communities} locationId={community.id}
        tab={query.tab === "runs" ? "runs" : "sources"} runId={query.tab === "runs" ? query.run ?? null : null} operator={principal.role !== "editor"} />}
  </section>;
}
