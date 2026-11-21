import { PageHeader } from "../../newsroom-ui";
import { loadNewsroom } from "../newsroom-context";
import StoryVideos from "./story-videos";

/** Videos: the story videos that exist, each opening its Video Studio. New ones start from New video. */
export default async function NewsroomVideosPage({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  const { publication } = await loadNewsroom(publicationId);
  return <section className="jw-channels" aria-labelledby="videos-title">
    <PageHeader eyebrow="Current" title="Videos" titleId="videos-title"
      description={`Videos of stories from ${publication.name}'s published editions.`} />
    <StoryVideos publicationId={publicationId} mode="existing" />
  </section>;
}
