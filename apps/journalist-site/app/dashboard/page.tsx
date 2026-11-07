import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import DashboardHome from "./dashboard-home";

export default async function DashboardPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="dashboard" title="Newsroom overview"
    description="Community activity and items needing attention.">
    <DashboardHome />
  </AdminShell>;
}
