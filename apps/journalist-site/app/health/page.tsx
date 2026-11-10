import { redirect } from "next/navigation";
import Link from "next/link";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import HealthDashboard from "./health-dashboard";
import ModelUsageDashboard from "../model-usage/model-usage-dashboard";

export default async function SystemPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  const usage = (await searchParams).view === "usage";
  return <AdminShell email={email} page="health" title="System">
    <nav className="tabs" aria-label="System views">
      <Link href="/health" aria-current={!usage ? "page" : undefined}>Pipeline</Link>
      <Link href="/health?view=usage" aria-current={usage ? "page" : undefined}>Model usage</Link>
    </nav>
    {usage ? <ModelUsageDashboard /> : <HealthDashboard />}
  </AdminShell>;
}
