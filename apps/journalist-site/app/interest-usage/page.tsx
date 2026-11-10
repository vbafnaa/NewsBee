import InternalMapPage from "../components/internal-map-page";
import { currentPrincipal } from "@/lib/admin-session";
import UsageMap from "./usage-map";

export const dynamic = "force-dynamic";
export default async function InterestUsagePage({ searchParams }: { searchParams: Promise<{ unlock?: string }> }) {
  const principal = await currentPrincipal().catch(() => null);
  // Called directly, so the page is the shell it chose (the workspace, or the gated map layout).
  return await InternalMapPage({
    page: "interest-usage", title: "Interest and usage map", description: "Readership and demand by community, not reader location.",
    returnTo: "/interest-usage", unlock: (await searchParams).unlock,
    children: <UsageMap signedIn={Boolean(principal)} />,
  });
}
