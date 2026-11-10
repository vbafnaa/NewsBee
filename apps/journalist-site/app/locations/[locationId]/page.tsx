import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import AdminShell from "../../admin-shell";
import LocationTabs from "./location-tabs";
import { LOCATION_TABS, MOVED_TABS } from "./tabs";
import { pipelineDeps } from "@/lib/pipeline";
import { getLocation } from "@/pipeline/communities/locations";
import { getRun } from "@/pipeline/orchestration/runs";

export default async function LocationPage({ params, searchParams }: { params: Promise<{ locationId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  const email = principal.email;
  const { locationId } = await params;
  const query = await searchParams;
  if (query.tab === "videos" || query.tab === "video") {
    redirect(`/publishing?location=${encodeURIComponent(locationId)}`);
  }
  const deps = await pipelineDeps();
  if (query.tab === "runs" && typeof query.run === "string") {
    const run = await getRun(deps.db, query.run);
    if (run?.location_id === locationId) {
      const tab = run.kind === "map" ? "collect-sources" : "edition";
      redirect(`/locations/${encodeURIComponent(locationId)}?${new URLSearchParams({ tab, run: query.run })}`);
    }
  }
  if (typeof query.tab === "string" && MOVED_TABS[query.tab]) {
    redirect(`/locations/${encodeURIComponent(locationId)}?${new URLSearchParams({ tab: MOVED_TABS[query.tab], ...(typeof query.run === "string" ? { run: query.run } : {}) })}`);
  }
  const tab = typeof query.tab === "string" && LOCATION_TABS.some(([id]) => id === query.tab) ? query.tab : "overview";
  const location = await getLocation(deps.db, locationId, true);
  return <AdminShell email={email} page="locations" title={tab === "settings" ? `${location.name} settings` : location.name}>
    <LocationTabs locationId={locationId} tab={tab} name={location.name} owner={principal.role === "owner"}
      runId={typeof query.run === "string" ? query.run : null} />
  </AdminShell>;
}
