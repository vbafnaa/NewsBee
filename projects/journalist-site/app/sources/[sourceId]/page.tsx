import { auth, isAdminEmail, listConfiguredSources } from "@/auth";
import { redirect, notFound } from "next/navigation";
import AdminShell from "../../admin-shell";
import SourcePipelineManagement from "./source-pipeline-management";

type PageContext = { params: Promise<{ sourceId: string }> };

export default async function SourcePage({ params }: PageContext) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !(await isAdminEmail(email))) redirect("/login");

  const { sourceId } = await params;
  const source = (await listConfiguredSources()).find((entry) => entry.id === sourceId);
  if (!source) notFound();

  return (
    <AdminShell email={email} page="sources" title={`${source.name} pipeline`}
      description="Queue ingestion, advance pipeline stages, and inspect this source’s history and Drive artifacts.">
      <SourcePipelineManagement sourceId={source.id} />
    </AdminShell>
  );
}
