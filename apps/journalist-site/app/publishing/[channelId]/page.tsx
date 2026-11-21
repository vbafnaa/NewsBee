import { redirect } from "next/navigation";

export default async function ChannelWorkspacePage({ params, searchParams }: {
  params: Promise<{ channelId: string }>;
  searchParams: Promise<{ draft?: string; generation?: string }>;
}) {
  const { channelId } = await params;
  const { draft, generation } = await searchParams;
  const query = new URLSearchParams({ ...(draft ? { draft } : {}), ...(generation ? { generation } : {}) });
  redirect(`/newsroom/${encodeURIComponent(channelId)}${query.size ? `?${query}` : ""}`);
}
