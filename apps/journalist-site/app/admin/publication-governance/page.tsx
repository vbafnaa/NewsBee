import AdminShell from "@/app/admin-shell";
import { requireOperatorPrincipal } from "@/lib/portal-access";
import { getDatabase } from "@/pipeline/storage/mongo";
import { listOutputChannelDirectory } from "@/pipeline/orchestration/output-channels";
import GovernancePanel from "./governance-panel";

export default async function PublicationGovernancePage({
  searchParams,
}: { searchParams: Promise<{ publicationId?: string }> }) {
  const principal = await requireOperatorPrincipal();
  const db = await getDatabase();
  const publications = await listOutputChannelDirectory(db, principal);
  return <AdminShell email={principal.email} page="publication-governance" title="Publication governance"
    description="Deliberate support access, ownership transfer and bounded historical evidence.">
    <GovernancePanel owner={principal.role === "owner"} publications={publications}
      initialPublicationId={(await searchParams).publicationId} />
  </AdminShell>;
}
