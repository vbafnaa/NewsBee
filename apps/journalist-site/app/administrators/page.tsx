import { currentAdmin } from "@/lib/admin-session";
import { redirect } from "next/navigation";
import AdminManagement from "./admin-management";
import AdminShell from "../admin-shell";

export default async function AdministratorsPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");

  return (
    <AdminShell email={email} page="administrators" title="Administrator access"
      description="Manage who can sign in to the journalist workspace.">
      <AdminManagement />
    </AdminShell>
  );
}
