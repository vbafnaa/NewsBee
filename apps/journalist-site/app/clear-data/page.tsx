import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import ClearData from "./clear-data";

export default async function ClearDataPage() {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  if (principal.role !== "owner") redirect("/account");
  const email = principal.email;
  return <AdminShell email={email} page="clear-data" title="Clear reader data"
    description="Choose reader-data categories to delete for one location or all of them. Signup emails are kept unless explicitly selected.">
    <ClearData />
  </AdminShell>;
}
