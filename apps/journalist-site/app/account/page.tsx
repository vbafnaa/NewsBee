import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import AccountSettings from "./settings";

export default async function AccountPage() {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  return <AdminShell email={principal.email} page="account" title="Environment & API settings"
    description="Configure personal API keys for provider-backed actions. Deployment defaults are owner-only. No keys are needed to browse.">
    <AccountSettings owner={principal.role === "owner"} />
  </AdminShell>;
}
