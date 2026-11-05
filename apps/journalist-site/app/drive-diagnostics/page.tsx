import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import DriveDiagnostics from "./drive-diagnostics";

export default async function DriveDiagnosticsPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="drive-diagnostics" title="Drive diagnostics"
    description="Check the account and folder used for pipeline artifacts and job logs.">
    <DriveDiagnostics />
  </AdminShell>;
}
