import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import HealthDashboard from "./health-dashboard";

export default async function HealthPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="health" title="Product health"
    description="See current service health, spot trends, and investigate locations that need attention.">
    <HealthDashboard />
  </AdminShell>;
}
