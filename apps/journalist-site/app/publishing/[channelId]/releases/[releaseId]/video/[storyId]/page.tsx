import { redirect } from "next/navigation";

export default async function ReleaseVideoPage({
  params,
}: {
  params: Promise<{ channelId: string; releaseId: string; storyId: string }>;
}) {
  const { channelId, releaseId, storyId } = await params;
  redirect(`/newsroom/${encodeURIComponent(channelId)}/releases/${encodeURIComponent(releaseId)}/video/${encodeURIComponent(storyId)}`);
}
