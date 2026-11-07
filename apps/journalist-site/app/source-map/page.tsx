import MapShell from "../components/map-shell";
import InternalGate from "../components/internal-gate";
import SourceReview from "./source-review";
import { currentPrincipal } from "@/lib/admin-session";

export const dynamic = "force-dynamic";
export default async function SourceMapPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const params = new URLSearchParams();
  for (const key of ["location", "mode", "run", "view"]) if (typeof query[key] === "string") params.set(key, query[key]);
  return <MapShell page="source-map" title="Source map"
    description="Review source networks and trace edition decisions.">
    <InternalGate returnTo={`/source-map?${params}`} error={typeof query.unlock === "string" ? query.unlock : undefined}>
      <Review locationId={params.get("location") ?? ""} mode={params.get("mode") ?? (params.get("location") ? "edition" : "inventory")} runId={params.get("run")} view={params.get("view") ?? "funnel"} />
    </InternalGate>
  </MapShell>;
}

/** Rendered only once the map is unlocked. A signed-in journalist can also label sources here. */
async function Review(props: { locationId: string; mode: string; runId: string | null; view: string }) {
  const canLabel = Boolean(await currentPrincipal().catch(() => null));
  return <SourceReview {...props} canLabel={canLabel} />;
}
