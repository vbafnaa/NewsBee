import { currentPrincipal } from "@/lib/admin-session";
import { redirect } from "next/navigation";
import AdminManagement from "./admin-management";
import AdminShell from "../admin-shell";

export default async function AdministratorsPage() {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  if (principal.role !== "owner") redirect("/account");
  const email = principal.email;

  return (
    <AdminShell email={email} page="administrators" title="Users"
      description="Manage who can sign in to the journalist workspace.">
      <AdminManagement />
    </AdminShell>
  );
}
