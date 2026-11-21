import AdminShell from "@/app/admin-shell";
import PublishingChannels from "@/app/publishing/channels";
import { requireOperatorPrincipal } from "@/lib/portal-access";
import NewsroomManagement from "./newsroom-management";

export default async function AdminPublicationsPage() {
  const principal = await requireOperatorPrincipal();
  return <AdminShell email={principal.email} page="output-channels" title="Newsrooms"
    description="Open a current newsroom. Archived newsrooms and legacy destinations are kept under maintenance below.">
    <NewsroomManagement />
    <details className="panel"><summary>Create newsroom</summary>
      <PublishingChannels email={principal.email} surface="admin" creationOnly />
    </details>
  </AdminShell>;
}
