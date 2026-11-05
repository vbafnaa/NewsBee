import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import ModelUsageDashboard from "./model-usage-dashboard";

export default async function ModelUsagePage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="model-usage" title="Model usage"
    description="Understand which models power each community: calls, reported tokens, estimated cost and pipeline roles.">
    <ModelUsageDashboard />
  </AdminShell>;
}
