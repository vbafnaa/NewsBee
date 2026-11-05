import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import DashboardHome from "./dashboard-home";

export default async function DashboardPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="dashboard" title="Newsroom overview"
    description="Start with the health of every community. Open a location to review inputs, prepare its next edition and follow it through publication.">
    <DashboardHome />
  </AdminShell>;
}
