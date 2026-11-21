import Link from "next/link";
import { Icon, PageHeader, StatusPill } from "../../../newsroom-ui";
import { loadNewsroom, newsroomCommunities } from "../../newsroom-context";
import { sourceMapHref } from "../../../newsroom-routes";

/**
 * Collect sources (frame 04, "New source map"): start a source run for a community this newsroom covers.
 * Creating a brand-new location stays in Operations.
 */
export default async function NewsroomCollectSourcesPage({ params, searchParams }: {
  params: Promise<{ publicationId: string }>;
  searchParams: Promise<{ location?: string }>;
}) {
  const { publicationId } = await params;
  const { location } = await searchParams;
  const { db, publication } = await loadNewsroom(publicationId);
  const communities = await newsroomCommunities(db, publication.selectedLocationIds);
  const community = communities.find((item) => item.id === location) ?? communities[0];
  return <section aria-labelledby="collect-title">
    <PageHeader eyebrow="Create" title="Create a source map" titleId="collect-title"
      description="Build a trusted foundation of primary local sources for this newsroom." />
    <div className="jw-card jw-intro">
      <div>
        <span className="jw-intro-mark"><Icon name="map" size={22} /></span>
        <StatusPill status="editing">Get started</StatusPill>
        <h2>Create a source map</h2>
        <p>Build a trusted foundation of primary local sources for {publication.name}. A source run searches, checks what it finds and proposes sources for you to review. It uses the newsroom&apos;s managed services and allowance.</p>
        {community
          ? <form className="jw-collect-form" action={`/newsroom/${encodeURIComponent(publicationId)}/source-map`} method="get">
            <input type="hidden" name="tab" value="runs" />
            {communities.length > 1
              ? <label className="field">Community<select name="location" defaultValue={community.id}>{communities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              : <input type="hidden" name="location" value={community.id} />}
            <button type="submit">Get started<Icon name="arrow" size={14} /></button>
          </form>
          : <p className="notice">{publication.name} doesn&apos;t cover any communities yet.</p>}
        <p className="chart-caption">The source map is shared: what a run finds, and what you accept, applies to every newsroom covering that community. Adding a new community is done in Operations.</p>
      </div>
      <ol className="jw-intro-steps">
        <li><span><strong>Choose a covered community</strong><small>Any community {publication.name} covers.</small></span></li>
        <li><span><strong>Discover local organizations</strong><small>Fixed readers and the search agent find candidate sources.</small></span></li>
        <li><span><strong>Review and approve suggested sources</strong><small>Accept or reject each one; decisions are recorded with your name.</small></span></li>
        <li><span><strong>Use them in the next edition</strong><small>Accepted sources feed the editions you generate.</small></span></li>
      </ol>
    </div>
    {community && <p><Link href={sourceMapHref(publicationId, community.id, "runs")}>See earlier collection runs</Link></p>}
  </section>;
}
