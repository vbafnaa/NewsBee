import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import ClearData from "./clear-data";
import SourceDataClear from "./source-data-clear";

export default async function ClearDataPage() {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  if (principal.role !== "owner") redirect("/account");
  const email = principal.email;
  return <AdminShell email={email} page="clear-data" title="Clear data">
    <p>Owners only. Nothing is selected until you choose it, and each clear is recorded.</p>
    <h2>Reader data</h2>
    <ClearData />
    <h2>Source data</h2>
    <SourceDataClear />
  </AdminShell>;
}
