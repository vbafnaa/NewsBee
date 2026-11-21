import { requireOwnerPrincipal } from "@/lib/portal-access";
import AdminShell from "../admin-shell";
import SiteBackup from "./site-backup";

export default async function SiteBackupPage() {
  const principal = await requireOwnerPrincipal();
  return <AdminShell email={principal.email} page="site-backup" title="Full site backup & restore"
    description="Move the complete Newsbee site data set between stacks.">
    <SiteBackup />
  </AdminShell>;
}
