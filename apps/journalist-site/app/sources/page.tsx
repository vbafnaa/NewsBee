import { currentAdmin } from "@/lib/admin-session";
import { redirect } from "next/navigation";
import AdminShell from "../admin-shell";
import SourceManagement from "./source-management";

export default async function SourcesPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");

  return (
    <AdminShell email={email} page="sources" title="Connectors & links"
      description="Inspect pipeline connectors and their discovered links. Add validated links for an onboarded location.">
      <SourceManagement />
    </AdminShell>
  );
}
