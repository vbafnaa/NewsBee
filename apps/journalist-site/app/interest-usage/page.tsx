import MapShell from "../components/map-shell";
import InternalGate from "../components/internal-gate";
import UsageMap from "./usage-map";

export const dynamic = "force-dynamic";
export default async function InterestUsagePage({ searchParams }: { searchParams: Promise<{ unlock?: string }> }) {
  return <MapShell page="interest-usage" title="Interest and usage map"
    description="Understand readership and demand by newsletter or requested community, never by a reader's physical location.">
    <InternalGate returnTo="/interest-usage" error={(await searchParams).unlock}><UsageMap /></InternalGate>
  </MapShell>;
}
