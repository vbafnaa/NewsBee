import { currentAdmin } from "@/lib/admin-session";
import { redirect } from "next/navigation";
import Dashboard from "./dashboard";
import AdminShell from "./admin-shell";

export default async function Home() {
  const email = await currentAdmin();
  if (!email) redirect("/login");

  return (
    <AdminShell email={email} page="dashboard" title="Runs & locations"
      description="Choose a town, add its sources, and follow each edition from collection to publication.">
      <Dashboard />
    </AdminShell>
  );
}
