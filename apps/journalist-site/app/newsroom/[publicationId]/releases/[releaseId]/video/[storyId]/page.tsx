import Link from "next/link";
import ReleaseVideoManager from "@/app/publishing/[channelId]/releases/[releaseId]/video/[storyId]/release-video-manager";
import { requirePublicationCapability } from "@/pipeline/publications/permissions";
import { newsroomReleaseHref } from "../../../../../newsroom-routes";
import { PageHeader } from "../../../../../newsroom-ui";
import { loadNewsroom } from "../../../../newsroom-context";

export default async function NewsroomReleaseVideoPage({
  params,
}: {
  params: Promise<{ publicationId: string; releaseId: string; storyId: string }>;
}) {
  const { publicationId, releaseId, storyId } = await params;
  const { principal } = await loadNewsroom(publicationId);
  requirePublicationCapability(principal, "publication:read");
  return <>
    <PageHeader eyebrow={<Link href={newsroomReleaseHref(publicationId, releaseId)}>Video Studio</Link>} title="Story video"
      description="Create and review a script, then generate or upload a video for this published story." />
    <ReleaseVideoManager publicationId={publicationId} releaseId={releaseId} storyId={storyId} />
  </>;
}
