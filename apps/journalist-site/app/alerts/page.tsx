import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import AlertsList from "./alerts-list";

export default async function AlertsPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="alerts" title="Alerts"
    description="Resolve source and pipeline issues. Alerts clear when resolved.">
    <AlertsList />
  </AdminShell>;
}
