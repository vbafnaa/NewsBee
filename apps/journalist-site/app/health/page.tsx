import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import HealthDashboard from "./health-dashboard";

export default async function HealthPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="health" title="System health"
    description="Global scheduler, job queue, source and location health, with historical production trends.">
    <HealthDashboard />
  </AdminShell>;
}
