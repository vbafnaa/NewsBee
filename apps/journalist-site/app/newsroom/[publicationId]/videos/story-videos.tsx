import Link from "next/link";
import { listPublicationReleaseStories } from "@/pipeline/publications/releases";
import { publicationReleaseVideoStates, type VideoJobStatus } from "@/pipeline/video-production";
import { newsroomHref, newsroomReleaseHref } from "../../newsroom-routes";
import { Icon, StatusPill, formatDate, formatEditionWindow } from "../../newsroom-ui";
import { loadNewsroom } from "../newsroom-context";

function videoStatus(status: VideoJobStatus | undefined) {
  if (!status) return <StatusPill status="muted">No video yet</StatusPill>;
  if (status === "complete") return <StatusPill status="ok">Video ready</StatusPill>;
  if (status === "failed" || status === "upload_failed") return <StatusPill status="failed">Needs attention</StatusPill>;
  return <StatusPill status="running">In production</StatusPill>;
}

/**
 * Story videos: one video per published story (P6), each opening its Video Studio.
 * - "existing" (Videos): only stories that already have a video. Nothing here creates one.
 * - "pick" (New video): every published story, to choose the one to make a video for.
 * Each row also links to its release page (release safety and email history).
 */
export default async function StoryVideos({ publicationId, mode }: { publicationId: string; mode: "existing" | "pick" }) {
  const { db, access } = await loadNewsroom(publicationId);
  const [releases, videos] = await Promise.all([
    listPublicationReleaseStories(db, access.context).catch(() => null),
    publicationReleaseVideoStates(db, publicationId).catch(() => null),
  ]);
  const all = releases?.flatMap((release) => release.stories.map((story) => ({ release, story, video: videos?.get(`${release.releaseId}:${story.id}`) }))) ?? [];
  const rows = mode === "existing" ? all.filter((row) => row.video) : all.filter((row) => !row.release.withdrawn);
  return <section aria-label={mode === "existing" ? "Story videos" : "Published stories"}>
    {!releases && <p className="alert" role="alert">Published stories couldn&apos;t be loaded. Refresh to try again.</p>}
    {releases && !rows.length && <div className="jw-card jw-empty">
      {mode === "existing"
        ? <p>No videos yet. Start one from <Link href={newsroomHref(publicationId, "new-video")}>New video</Link>.</p>
        : <><p>Videos start from published stories. Nothing has been published in this newsroom yet.</p>
          <Link className="jw-button" href={newsroomHref(publicationId, "editions")}>Go to editions</Link></>}
    </div>}
    {rows.length > 0 && <div className="jw-card jw-table-card">
      <div className="jw-table-scroll">
        <table className="jw-table">
          <thead><tr><th scope="col">Story</th><th scope="col">Edition</th>
            {mode === "pick" && <th scope="col">Communities</th>}
            <th scope="col">Video</th>{mode === "existing" && <th scope="col">Updated</th>}
            <th scope="col"><span className="visually-hidden">Open</span></th></tr></thead>
          <tbody>{rows.map(({ release, story, video }) => <tr key={`${release.releaseId}:${story.id}`}>
            <td><strong>{story.headline}</strong></td>
            <td>{release.title}<br /><small>{formatEditionWindow([release.windowStart, release.windowEnd])} · Published {formatDate(release.publishedAt)}
              {" · "}<Link href={newsroomReleaseHref(publicationId, release.releaseId)}>Release details &amp; email history</Link></small></td>
            {mode === "pick" && <td>{story.locations.join(", ") || "—"}</td>}
            <td>{release.withdrawn ? <StatusPill status="withdrawn" /> : videos ? videoStatus(video?.status) : <StatusPill status="muted">Unavailable</StatusPill>}</td>
            {mode === "existing" && <td>{video ? formatDate(video.created_at / 1000) : "—"}</td>}
            <td>{!release.withdrawn && <Link className="jw-link-arrow" aria-label={`Open Video Studio for ${story.headline}`}
              href={newsroomReleaseHref(publicationId, release.releaseId, story.id)}>{mode === "pick" && !video ? "Choose" : "Open"}<Icon name="arrow" size={14} /></Link>}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>}
  </section>;
}
