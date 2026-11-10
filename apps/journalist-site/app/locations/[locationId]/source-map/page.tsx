import { notFound, redirect } from "next/navigation";
import AdminShell from "../../../admin-shell";
import SourceReview from "../../../source-map/source-review";
import { currentPrincipal } from "@/lib/admin-session";
import { pipelineDeps } from "@/lib/pipeline";
import { getLocation } from "@/pipeline/communities/locations";

export const dynamic = "force-dynamic";

export default async function LocationSourceMapPage({ params, searchParams }: {
  params: Promise<{ locationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  const { locationId } = await params;
  const query = await searchParams;
  let location;
  try {
    location = await getLocation((await pipelineDeps()).db, locationId, true);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Location is not onboarded:")) notFound();
    throw cause;
  }
  const tab = query.tab === "runs" ? "runs" : "sources";
  const runId = typeof query.run === "string" ? query.run : null;
  return <AdminShell email={principal.email} page="locations" title={`${location.name} source map`}
    description="Sources and source runs for this location.">
    <p className="breadcrumbs"><a href="/locations">Overview</a> / <a href={`/locations/${encodeURIComponent(locationId)}`}>{location.name}</a> / Source map</p>
    <SourceReview locationId={locationId} locationName={location.name} tab={tab} runId={runId} signedIn showLocationPicker={false}
      basePath={`/locations/${encodeURIComponent(locationId)}/source-map`} />
  </AdminShell>;
}
