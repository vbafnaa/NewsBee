import { auth, isAdminEmail } from "@/auth";
import { redirect } from "next/navigation";
import Dashboard from "./dashboard";
import AdminShell from "./admin-shell";

export default async function Home() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !(await isAdminEmail(email))) redirect("/login");

  return (
    <AdminShell email={email} page="dashboard" title="Journalist workspace"
      description="Manage active sources and run ingestion for onboarded communities.">
      <Dashboard />
    </AdminShell>
  );
}
