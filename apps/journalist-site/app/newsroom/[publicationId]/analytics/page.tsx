import { PageHeader, StatCard } from "../../newsroom-ui";
import { SAMPLE_ANALYTICS, SampleActivityChart, SampleTag } from "../../sample-analytics";
import { loadNewsroom } from "../newsroom-context";

/** Frame 09 layout with clearly labelled sample data. Real analytics ship in a later release. */
export default async function NewsroomAnalyticsPage({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  const { publication } = await loadNewsroom(publicationId);
  return <section className="jw-analytics" aria-labelledby="analytics-title">
    <PageHeader eyebrow="Performance" title="Analytics" titleId="analytics-title"
      description="Understand how your local reporting is reaching the community."
      actions={<label className="jw-filter"><span className="visually-hidden">Period</span>
        <select defaultValue="30" disabled aria-describedby="analytics-sample"><option value="30">Last 30 days</option><option value="7">Last 7 days</option><option value="90">Last 90 days</option></select></label>} />
    <p className="jw-sample-banner" id="analytics-sample" role="note"><strong>Preview · sample data.</strong> Real analytics ship in a later release. None of these numbers come from {publication.name}&apos;s readers.</p>
    <div className="jw-stats" aria-label="Sample figures">
      <StatCard label="Page views" icon="eye" value={SAMPLE_ANALYTICS.pageViews} detail="Sample · +14.2% from last period" />
      <StatCard label="Unique readers" icon="users" value={SAMPLE_ANALYTICS.uniqueReaders} detail="Sample · +18.4% from last period" />
      <StatCard label="Avg. read time" icon="clock" value={SAMPLE_ANALYTICS.readTime} detail="Sample · +24 sec from last period" />
      <StatCard label="Video plays" icon="video" value={SAMPLE_ANALYTICS.videoPlays} detail="Sample · +9.8% from last period" />
    </div>
    <article className="jw-card" aria-labelledby="reader-activity-title">
      <div className="jw-card-head">
        <div><p className="jw-eyebrow" id="reader-activity-title">Reader activity</p><p className="jw-chart-figure">{SAMPLE_ANALYTICS.uniqueReaders}</p><p className="jw-stat-detail">Unique views, last 30 days</p></div>
        <div className="jw-card-tags"><span className="jw-trend">↗ {SAMPLE_ANALYTICS.activityChange}</span><SampleTag /></div>
      </div>
      <SampleActivityChart height={230} />
    </article>
  </section>;
}
