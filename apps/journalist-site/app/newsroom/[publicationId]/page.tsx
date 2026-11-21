import Link from "next/link";
import { listPublicationReleases } from "@/pipeline/publications/releases";
import { publicationReleaseVideoStates } from "@/pipeline/video-production";
import { newsroomSourceHealth } from "@/pipeline/sourcemap/store";
import { principalDisplayName } from "@/lib/display-name";
import { newsroomHref, sourceMapHref } from "../newsroom-routes";
import { Icon, StatCard } from "../newsroom-ui";
import { SAMPLE_ANALYTICS, SampleActivityChart, SampleTag } from "../sample-analytics";
import { Greeting, LegacyNewsroomRedirect } from "./overview-client";
import { loadNewsroom } from "./newsroom-context";

const IN_PRODUCTION = new Set(["submitting", "queued", "processing", "uploading"]);

function ago(seconds: number | null) {
  if (!seconds) return "Not checked yet";
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  if (minutes < 1) return "Last checked just now";
  if (minutes < 60) return `Last checked ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `Last checked ${hours} h ago` : `Last checked ${Math.round(hours / 24)} days ago`;
}

/**
 * Overview (frame 01). The page renders the greeting, the stat row, the sample reader-activity card and the source
 * health card; the edition workspace in the layout adds the pipeline and latest-editions cards. One CSS grid places
 * all of them in the mock's three rows (see .jw-overview-layout in newsroom.css).
 */
export default async function NewsroomOverviewPage({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  const { principal, db, access, publication } = await loadNewsroom(publicationId);
  const [releases, videos, sources, name] = await Promise.all([
    listPublicationReleases(db, access.context).catch(() => null),
    publicationReleaseVideoStates(db, publicationId).catch(() => null),
    newsroomSourceHealth(db, publication.selectedLocationIds).catch(() => null),
    principalDisplayName(principal),
  ]);
  const live = releases?.filter((release) => release.action?.action !== "withdraw") ?? null;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const thisMonth = live?.filter((release) => release.publishedAt * 1000 >= monthStart.getTime()).length ?? 0;
  const videoStates = videos ? [...videos.values()] : null;
  const completeVideos = videoStates?.filter((video) => video.status === "complete").length ?? null;
  const producingVideos = videoStates?.filter((video) => IN_PRODUCTION.has(video.status)).length ?? 0;
  const healthyShare = sources && sources.active ? Math.round((sources.healthy / sources.active) * 100) : null;
  const attentionLocation = sources?.firstAttentionLocation ?? publication.selectedLocationIds[0];
  return <section className="newsroom-overview jw-overview-layout" aria-labelledby="workspace-title">
    <LegacyNewsroomRedirect publicationId={publicationId} />
    <header className="jw-page-header jw-area-head">
      <div className="jw-page-heading">
        <Greeting name={name.first} newsroom={publication.name} />
      </div>
      <div className="jw-page-actions">
        <Link className="jw-button" href={newsroomHref(publicationId, "new-edition")}><Icon name="sparkle" />Create new edition</Link>
      </div>
    </header>
    <div className="jw-stats jw-area-stats" aria-label="Newsroom at a glance">
      <StatCard label="Published editions" icon="edition" value={live?.length ?? "—"}
        detail={live ? `${thisMonth} this month${releases && releases.length > live.length ? ` · ${releases.length - live.length} withdrawn` : ""}` : "Unavailable right now"} />
      <StatCard label="Active sources" icon="map" value={sources?.active ?? "—"}
        detail={sources ? `${sources.healthy} healthy · ${sources.needReview} need review` : "Unavailable right now"} />
      <StatCard label="Published videos" icon="video" value={completeVideos ?? "—"}
        detail={videoStates ? `${producingVideos} in production` : "Unavailable right now"} />
      <StatCard label="Total readership" icon="users" value={SAMPLE_ANALYTICS.totalReadership} tag={<SampleTag />}
        detail={SAMPLE_ANALYTICS.readershipChange} />
    </div>
    <article className="jw-card jw-area-chart" aria-labelledby="reader-activity-title">
      <div className="jw-card-head">
        <div>
          <p className="jw-eyebrow" id="reader-activity-title">Reader activity</p>
          <p className="jw-chart-figure">{SAMPLE_ANALYTICS.uniqueReaders}</p>
          <p className="jw-stat-detail">Unique views, last 30 days</p>
        </div>
        <div className="jw-card-tags"><span className="jw-trend">↗ {SAMPLE_ANALYTICS.activityChange}</span><SampleTag /></div>
      </div>
      <SampleActivityChart />
    </article>
    <section className="jw-card jw-area-health" aria-labelledby="source-health-title">
      <div className="jw-card-head">
        <div><p className="jw-eyebrow">Source health</p><h2 id="source-health-title">Collection status</h2></div>
        <Link className="jw-card-more" href={newsroomHref(publicationId, "source-map")} aria-label="Open the source map">⋯</Link>
      </div>
      {!sources ? <p className="jw-stat-detail">Source health is unavailable right now.</p>
        : !sources.active ? <p className="jw-stat-detail">No active sources yet. <Link href={newsroomHref(publicationId, "collect-sources")}>Collect sources</Link> for a community to start.</p>
          : <>
            <div className="jw-health-figure">
              <strong>{healthyShare}%</strong>
              <span><b>{sources.healthy} of {sources.active} healthy</b><small>{ago(sources.lastCheckedAt)}</small></span>
            </div>
            <div className="jw-health-bar" role="img" aria-label={`${healthyShare}% of active sources healthy`}><span style={{ width: `${healthyShare}%` }} /></div>
          </>}
      {sources && (sources.needAttention > 0 || sources.needReview > 0) && attentionLocation &&
        <Link className="jw-callout" href={sourceMapHref(publicationId, attentionLocation)}>
          <span className="jw-callout-dot" aria-hidden="true" />
          <span><strong>{sources.needAttention + sources.needReview} {sources.needAttention + sources.needReview === 1 ? "source needs" : "sources need"} attention</strong>
            <small>{[sources.needAttention && `${sources.needAttention} failing`, sources.needReview && `${sources.needReview} waiting for review`].filter(Boolean).join(" · ")}</small></span>
          <Icon name="arrow" size={16} />
        </Link>}
    </section>
  </section>;
}
