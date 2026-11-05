import { currentAdmin } from "@/lib/admin-session";
import { redirect } from "next/navigation";
import AdminShell from "../admin-shell";
import RemembranceReview from "./remembrance-review";

export default async function RemembrancePage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return (
    <AdminShell email={email} page="remembrance" title="Remembrances"
      description="Death notices families submitted on the reader site. Confirm each one with the submitter before approving; only approved notices are published.">
      <RemembranceReview />
    </AdminShell>
  );
}
