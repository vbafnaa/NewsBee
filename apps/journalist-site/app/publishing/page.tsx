import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import PublishingChannels from "./channels";

export default async function PublishingPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  const { location } = await searchParams;
  return <AdminShell email={principal.email} page="output-channels" title="Publishing channels"
    description="Create channels and open a channel workspace to manage its destinations and communities.">
    <PublishingChannels focusLocationId={location} owner={principal.role === "owner"} email={principal.email} />
  </AdminShell>;
}
