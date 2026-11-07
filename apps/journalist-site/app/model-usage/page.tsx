import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import ModelUsageDashboard from "./model-usage-dashboard";

export default async function ModelUsagePage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="model-usage" title="Model usage"
    description="Model calls, reported tokens and estimated costs by community.">
    <ModelUsageDashboard />
  </AdminShell>;
}
