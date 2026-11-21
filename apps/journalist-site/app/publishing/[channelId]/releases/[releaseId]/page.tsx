import { redirect } from "next/navigation";

export default async function ReleaseDistributionPage({
  params,
}: {
  params: Promise<{ channelId: string; releaseId: string }>;
}) {
  const { channelId, releaseId } = await params;
  redirect(`/newsroom/${encodeURIComponent(channelId)}/releases/${encodeURIComponent(releaseId)}`);
}
