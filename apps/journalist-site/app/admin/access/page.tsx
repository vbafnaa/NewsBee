import AdminShell from "@/app/admin-shell";
import { requireOperatorPrincipal } from "@/lib/portal-access";
import AccessManagement from "./access-management";

export default async function AccessPage({ searchParams }: {
  searchParams: Promise<{ publicationId?: string; email?: string }>;
}) {
  const principal = await requireOperatorPrincipal();
  const context = await searchParams;
  return <AdminShell
    email={principal.email}
    page="administrators"
    title="People"
    description="Manage Newsbee operators, approved journalists, account status and newsroom assignments."
  >
    <AccessManagement publicationId={typeof context.publicationId === "string" ? context.publicationId : undefined}
      email={typeof context.email === "string" && context.email.length <= 254 ? context.email : undefined} />
  </AdminShell>;
}
