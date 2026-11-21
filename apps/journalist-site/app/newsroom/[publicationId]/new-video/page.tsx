import Link from "next/link";
import { newsroomHref } from "../../newsroom-routes";
import { Icon, PageHeader, StatusPill } from "../../newsroom-ui";
import { loadNewsroom } from "../newsroom-context";
import StoryVideos from "../videos/story-videos";

type Step = "intro" | "story";

/**
 * Add a video (frame 05), the only way to start one: Get started lists the stories from published editions, and
 * choosing one opens its Video Studio (script and captions, then generate or upload, then download).
 */
export default async function NewsroomNewVideoPage({ params, searchParams }: {
  params: Promise<{ publicationId: string }>; searchParams: Promise<{ step?: string }>;
}) {
  const { publicationId } = await params;
  const step: Step = (await searchParams).step === "story" ? "story" : "intro";
  const { publication } = await loadNewsroom(publicationId);
  const here = newsroomHref(publicationId, "new-video");
  return <section className="jw-channels jw-new-video" aria-labelledby="new-video-title">
    <PageHeader eyebrow="Create" title="Add a video" titleId="new-video-title"
      description={`Make a short video from one of ${publication.name}'s published stories.`} />
    {step === "intro" && <div className="jw-card jw-intro">
      <div>
        <span className="jw-intro-mark"><Icon name="video" size={22} /></span>
        <StatusPill status="editing">Story video</StatusPill>
        <h2>Create a news video</h2>
        <p>Turn a story from a published edition into a short video: write the script and captions, then generate or upload it.</p>
        <Link className="jw-button" href={`${here}?step=story`}>Get started<Icon name="arrow" size={14} /></Link>
      </div>
      <ol className="jw-intro-steps">
        <li><span><strong>Choose a story</strong><small>A story from one of your published editions</small></span></li>
        <li><span><strong>Write the script and captions</strong><small>Review what the video will say before anything is made</small></span></li>
        <li><span><strong>Generate or upload</strong><small>Create the video, or upload an MP4 you made yourself</small></span></li>
        <li><span><strong>Download</strong><small>Get the finished MP4 to share where you like</small></span></li>
      </ol>
    </div>}
    {step === "story" && <>
      <p className="jw-section-intro"><Link href={here}>← Back</Link> Choose a story from a published edition to open its Video Studio.</p>
      <StoryVideos publicationId={publicationId} mode="pick" />
    </>}
  </section>;
}
