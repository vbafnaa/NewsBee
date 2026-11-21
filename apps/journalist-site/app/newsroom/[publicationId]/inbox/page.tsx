import InboxView from "@/app/inbox/inbox-view";
import NeighbourStoryReview from "@/app/neighbour-stories/neighbour-story-review";
import RemembranceReview from "@/app/remembrance/remembrance-review";
import { PublicationScope } from "@/app/components/publication-scope";
import { PageHeader } from "../../newsroom-ui";
import { loadNewsroom } from "../newsroom-context";

/**
 * The newsroom's inbox: held stories in its drafts, reader source suggestions, problem reports, reader stories,
 * family notices and its own source feedback, for the communities it covers only. Community inquiries and
 * editor interest stay in Operations.
 */
export default async function NewsroomInboxPage({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  const { publication } = await loadNewsroom(publicationId);
  return <section className="jw-inbox" aria-labelledby="inbox-title">
    <PageHeader eyebrow="Workspace" title="Inbox" titleId="inbox-title"
      description={`Stories, sources and reports waiting for review in the communities ${publication.name} covers.`} />
    <PublicationScope publicationId={publicationId}>
      <InboxView />
      <div id="reader-stories"><NeighbourStoryReview /></div>
      <div id="family-notices"><RemembranceReview /></div>
    </PublicationScope>
  </section>;
}
