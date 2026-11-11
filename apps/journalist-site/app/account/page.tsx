import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import { isConfiguredOwner } from "@/pipeline/accounts/identity";
import AdminShell from "../admin-shell";
import AccountSettings from "./settings";

export default async function AccountPage() {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  return <AdminShell email={principal.email} page="account" title="Environment & API settings"
    description="Editors must configure personal API keys for provider-backed actions. Only the configured owner may use server defaults. No keys are needed to browse.">
    <AccountSettings owner={isConfiguredOwner(principal)} />
  </AdminShell>;
}
