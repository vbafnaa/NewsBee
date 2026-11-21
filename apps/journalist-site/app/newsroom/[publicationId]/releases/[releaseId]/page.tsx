import { notFound } from "next/navigation";
import ReleaseDistribution from "@/app/publishing/[channelId]/releases/[releaseId]/release-distribution";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { loadPublicationReleaseForDistribution } from "@/pipeline/publications/releases";
import { newsroomHref } from "../../../newsroom-routes";
import { PageHeader } from "../../../newsroom-ui";
import { loadNewsroom } from "../../newsroom-context";
import Link from "next/link";

export default async function NewsroomReleaseDistributionPage({
  params,
}: {
  params: Promise<{ publicationId: string; releaseId: string }>;
}) {
  const { publicationId, releaseId } = await params;
  const { principal, db, access } = await loadNewsroom(publicationId);
  requirePublicationCapability(principal, "publication:read");
  const loaded = await loadPublicationReleaseForDistribution(db, access.context, releaseId).catch(() => null);
  if (!loaded) notFound();
  return <>
    <PageHeader eyebrow={<Link href={newsroomHref(publicationId, "videos")}>Videos · Story videos</Link>} title="Video Studio"
      description="Choose a story from this published edition. Nothing is generated until you explicitly request it." />
    <ReleaseDistribution
      publicationId={publicationId}
      draftId={loaded.draftId}
      releaseId={releaseId}
      releaseHash={loaded.contentHash}
      title={loaded.payload.title}
      stories={loaded.payload.items.map((item) => ({
        id: item.item_id,
        headline: item.headline,
        locations: item.location_names,
      }))}
    />
  </>;
}
