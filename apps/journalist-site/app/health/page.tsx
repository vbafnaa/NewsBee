import { redirect } from "next/navigation";
import Link from "next/link";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import HealthDashboard from "./health-dashboard";
import ModelUsageDashboard from "../model-usage/model-usage-dashboard";
import NewsletterDelivery from "../newsletter/newsletter-delivery";

export default async function SystemPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  const view = (await searchParams).view;
  const usage = view === "usage";
  const video = view === "video";
  const commit = process.env.NEWSBEE_BUILD_COMMIT_SHA;
  return <AdminShell email={email} page="health" title="System">
    <p className="chart-caption">Running commit: <code>{commit || "unavailable (build commit metadata not provided)"}</code></p>
    <nav className="tabs" aria-label="System views">
      <Link href="/health" aria-current={!usage && !video ? "page" : undefined}>Pipeline</Link>
      <Link href="/health?view=usage" aria-current={usage ? "page" : undefined}>Model usage</Link>
      <Link href="/health?view=video" aria-current={video ? "page" : undefined}>Desktop Video</Link>
    </nav>
    {video ? <NewsletterDelivery videoOnly /> : usage ? <ModelUsageDashboard /> : <HealthDashboard />}
  </AdminShell>;
}
