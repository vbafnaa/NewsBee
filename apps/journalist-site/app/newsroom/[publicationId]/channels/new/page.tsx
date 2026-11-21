import { redirect } from "next/navigation";
import { newsroomHref } from "../../../newsroom-routes";

/** "New channel" became "New video". */
export default async function NewsroomNewChannelRedirect({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  redirect(newsroomHref(publicationId, "new-video"));
}
