import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../../admin-shell";
import LocationTabs from "./location-tabs";
import { pipelineDeps } from "@/lib/pipeline";
import { getLocation } from "@/pipeline/communities/locations";

export default async function LocationPage({ params, searchParams }: { params: Promise<{ locationId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  const { locationId } = await params;
  const query = await searchParams;
  if (query.tab === "sources" || query.tab === "map") redirect(`/source-map?${new URLSearchParams({ location: locationId, ...(query.tab === "map" ? { mode: "edition" } : {}), ...(typeof query.run === "string" ? { run: query.run } : {}) })}`);
  const tab = typeof query.tab === "string" && ["overview", "review", "runs", "editions", "settings"].includes(query.tab) ? query.tab : "overview";
  const location = await getLocation((await pipelineDeps()).db, locationId, true);
  return <AdminShell email={email} page="locations" title={location.name}
    description="Your community's editorial workspace. Prepare inputs, produce an edition, and review the result.">
    <LocationTabs locationId={locationId} tab={tab} name={location.name} />
  </AdminShell>;
}
