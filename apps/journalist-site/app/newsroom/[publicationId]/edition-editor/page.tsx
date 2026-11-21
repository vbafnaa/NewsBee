import { redirect } from "next/navigation";
import { currentPublicationDraftId } from "@/pipeline/publications/generation";
import { newsroomEditionHref, newsroomHref } from "../../newsroom-routes";
import { loadNewsroom } from "../newsroom-context";

/** Edition editor (sidebar): the newsroom's most recently edited unpublished draft, or Editions when there is none. */
export default async function NewsroomEditionEditorPage({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  const { db } = await loadNewsroom(publicationId);
  const draftId = await currentPublicationDraftId(db, publicationId);
  redirect(draftId ? newsroomEditionHref(publicationId, draftId) : newsroomHref(publicationId, "editions", "?no-draft=1"));
}
