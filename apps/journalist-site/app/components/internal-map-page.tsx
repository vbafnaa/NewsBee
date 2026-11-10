import type { ReactNode } from "react";
import AdminShell from "../admin-shell";
import MapShell from "./map-shell";
import InternalGate from "./internal-gate";
import { currentPrincipal } from "@/lib/admin-session";

/**
 * An internal map page. A signed-in journalist sees it inside the workspace; anyone else gets the
 * map layout behind the internal gate. Maps are read-only either way: editing is in each location's workspace.
 */
export default async function InternalMapPage({ page, title, description, returnTo, unlock, children }: { page: "source-map" | "edition-map" | "interest-usage"; title: string; description: string; returnTo: string; unlock?: string; children: ReactNode }) {
  const principal = await currentPrincipal().catch(() => null);
  if (principal) return <AdminShell email={principal.email} page={page} title={title} description={description}>{children}</AdminShell>;
  return <MapShell page={page} title={title} description={description}>
    <InternalGate returnTo={returnTo} error={unlock}>{children}</InternalGate>
  </MapShell>;
}
