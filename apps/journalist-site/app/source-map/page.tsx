import MapShell from "../components/map-shell";
import InternalGate from "../components/internal-gate";
import SourceReview from "./source-review";

export const dynamic = "force-dynamic";
export default async function SourceMapPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const params = new URLSearchParams();
  for (const key of ["location", "mode", "run", "view"]) if (typeof query[key] === "string") params.set(key, query[key]);
  return <MapShell page="source-map" title="Source map"
    description="Every choice behind each edition, from the first search to the printed page, and the source network behind it.">
    <InternalGate returnTo={`/source-map?${params}`} error={typeof query.unlock === "string" ? query.unlock : undefined}>
      <SourceReview locationId={params.get("location") ?? ""} mode={params.get("mode") ?? (params.get("location") ? "edition" : "inventory")} runId={params.get("run")} view={params.get("view") ?? "funnel"} />
    </InternalGate>
  </MapShell>;
}
