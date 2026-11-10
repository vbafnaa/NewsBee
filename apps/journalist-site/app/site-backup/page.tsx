import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import SiteBackup from "./site-backup";

export default async function SiteBackupPage() {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  return <AdminShell email={principal.email} page="site-backup" title="Import and export"
    description="Move the complete Newsbee site data set between stacks.">
    <SiteBackup />
  </AdminShell>;
}
