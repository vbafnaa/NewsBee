import { auth, isAdminEmail } from "@/auth";
import { redirect } from "next/navigation";
import AdminShell from "../admin-shell";
import SourceManagement from "./source-management";

export default async function SourcesPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !(await isAdminEmail(email))) redirect("/login");

  return (
    <AdminShell email={email} page="sources" title="Source management"
      description="Add, edit, and remove the sources used by Newsbee.">
      <SourceManagement />
    </AdminShell>
  );
}
