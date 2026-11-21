import { redirect } from "next/navigation";
import { newsroomHref } from "../../newsroom-routes";

/** Channels was removed; older links land on Videos. */
export default async function NewsroomChannelsRedirect({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  redirect(newsroomHref(publicationId, "videos"));
}
