import { requireOperatorPrincipal } from "@/lib/portal-access";
import { isConfiguredOwner } from "@/pipeline/accounts/identity";
import AdminShell from "../admin-shell";
import AccountSettings from "./settings";

export default async function AccountPage() {
  const principal = await requireOperatorPrincipal();
  const owner = isConfiguredOwner(principal);
  return <AdminShell email={principal.email} page="account" title={owner ? "Environment & API settings" : "Personal API keys"}
    description={owner
      ? "Manage deployment fallback selection and your encrypted personal provider overrides."
      : "Manage only your encrypted personal provider profile. Deployment settings and other operators' profiles remain private."}>
    <AccountSettings owner={owner} />
  </AdminShell>;
}
