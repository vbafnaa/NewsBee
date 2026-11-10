import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import AdminShell from "../../../admin-shell";
import VideoStoryManager from "./video-story-manager";

/** One story's video, accessed from a publishing channel. */
export default async function VideoStoryPage({ params, searchParams }: {
  params: Promise<{ locationId: string; storyId: string }>;
  searchParams: Promise<{ channel?: string }>;
}) {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  const { locationId, storyId } = await params;
  const { channel } = await searchParams;
  const backHref = channel && /^[a-f0-9]{32}$/.test(channel)
    ? `/publishing/${encodeURIComponent(channel)}`
    : `/publishing?location=${encodeURIComponent(locationId)}`;
  return <AdminShell email={principal.email} page="output-channels" title="Story video">
    <p className="breadcrumbs"><a href={backHref}>Channel workspace</a> / Story video</p>
    <VideoStoryManager locationId={locationId} storyId={storyId} accountEmail={principal.email} owner={principal.role === "owner"} backHref={backHref} />
  </AdminShell>;
}
