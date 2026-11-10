import { notFound, redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import AdminShell from "../../admin-shell";
import { pipelineDeps } from "@/lib/pipeline";
import { getOutputChannel } from "@/pipeline/orchestration/output-channels";
import PublishingChannels from "../channels";

export default async function ChannelWorkspacePage({ params }: { params: Promise<{ channelId: string }> }) {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  const { channelId } = await params;
  const channel = await getOutputChannel((await pipelineDeps()).db, principal.id, channelId);
  if (!channel) notFound();

  return <AdminShell email={principal.email} page="output-channels" title={`${channel.name} channel workspace`}
    description="Manage this channel's destinations, selected communities, and publishing tools.">
    <PublishingChannels channelId={channelId} owner={principal.role === "owner"} email={principal.email} />
  </AdminShell>;
}
