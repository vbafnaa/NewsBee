import { auth, isAdminEmail } from "@/auth";
import { redirect } from "next/navigation";
import AdminManagement from "./admin-management";
import AdminShell from "../admin-shell";

export default async function AdministratorsPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !(await isAdminEmail(email))) redirect("/login");

  return (
    <AdminShell email={email} page="administrators" title="Administrator access"
      description="Manage who can sign in to the journalist workspace.">
      <AdminManagement />
    </AdminShell>
  );
}
