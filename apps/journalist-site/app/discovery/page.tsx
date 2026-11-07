import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import DiscoveryView from "./discovery-view";

export default async function DiscoveryPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="discovery" title="Discovery"
    description="Source discovery results, errors and next runs.">
    <DiscoveryView />
  </AdminShell>;
}
