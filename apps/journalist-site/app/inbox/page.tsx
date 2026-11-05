import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import InboxView from "./inbox-view";
import NeighbourStoryReview from "../neighbour-stories/neighbour-story-review";
import RemembranceReview from "../remembrance/remembrance-review";

export default async function InboxPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="inbox" title="Inbox"
    description="Everything waiting for an editor: held stories, reader source suggestions, problem reports, reader stories and family notices.">
    <InboxView />
    <div id="reader-stories"><NeighbourStoryReview /></div>
    <div id="family-notices"><RemembranceReview /></div>
  </AdminShell>;
}
