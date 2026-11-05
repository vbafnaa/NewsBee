import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import ClearData from "./clear-data";

export default async function ClearDataPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="clear-data" title="Clear reader data"
    description="Permanently delete reader impressions, clicks and launch-interest signups, for one location or all of them.">
    <ClearData />
  </AdminShell>;
}
