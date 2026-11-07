import { currentPrincipal } from "@/lib/admin-session";
import { redirect } from "next/navigation";
import AdminShell from "../admin-shell";
import ApprovalManager from "./approval-manager";

export default async function ApprovalsPage() {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  if (principal.role !== "owner") redirect("/locations");
  return <AdminShell email={principal.email} page="approvals" title="Admin-token approvals" description="Review final-run requests. Editors start approved work from their location pipeline."><ApprovalManager /></AdminShell>;
}
