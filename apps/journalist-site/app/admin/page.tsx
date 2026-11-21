import AdminShell from "../admin-shell";
import LocationDirectory from "../locations/location-directory";
import { requireOperatorPrincipal } from "@/lib/portal-access";
import { campaignLeadSummary } from "@/pipeline/campaigns/leads";
import { getDatabase } from "@/pipeline/storage/mongo";
import AdminOverview from "./admin-overview";

export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await requireOperatorPrincipal();
  const params = await searchParams;
  const requested = typeof params.requested_location === "string" && typeof params.requested_name === "string"
    ? { id: params.requested_location, name: params.requested_name } : undefined;
  const campaignLeads = await campaignLeadSummary(await getDatabase());
  return <AdminShell email={principal.email} page="locations" title="Locations"
    description="Global location directory: prepare source maps, review assignment readiness and resolve exceptions.">
    <div id="location-requests"><LocationDirectory owner={principal.role === "owner"} requested={requested} /></div>
    <details className="panel"><summary>Campaign and intake diagnostics</summary><AdminOverview campaignLeads={campaignLeads} /></details>
  </AdminShell>;
}
