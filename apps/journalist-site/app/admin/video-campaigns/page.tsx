import AdminShell from "@/app/admin-shell";
import { requireOperatorPrincipal } from "@/lib/portal-access";
import VideoCampaignWorkspace from "./video-campaign-workspace";

export const dynamic = "force-dynamic";

export default async function VideoCampaignsPage() {
  const principal = await requireOperatorPrincipal();
  return <AdminShell email={principal.email} page="video-campaigns" title="Video campaigns"
    description="Create promotional videos from your own approved brief. Campaigns are private to the operator who creates them, separate from newsroom story videos and incoming campaign requests.">
    <VideoCampaignWorkspace />
  </AdminShell>;
}
