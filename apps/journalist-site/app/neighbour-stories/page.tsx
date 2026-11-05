import { currentAdmin } from "@/lib/admin-session";
import { redirect } from "next/navigation";
import AdminShell from "../admin-shell";
import NeighbourStoryReview from "./neighbour-story-review";

export default async function NeighbourStoriesPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return (
    <AdminShell email={email} page="neighbour-stories" title="Neighbour stories"
      description="Stories readers shared from their community's edition page. Check the details with the submitter if needed; only approved stories go into the next edition.">
      <NeighbourStoryReview />
    </AdminShell>
  );
}
