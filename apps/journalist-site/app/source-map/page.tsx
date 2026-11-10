import { redirect } from "next/navigation";
import InternalMapPage from "../components/internal-map-page";
import { currentPrincipal } from "@/lib/admin-session";
import { editionRedirect } from "@/lib/internal-access";
import SourceReview from "./source-review";

export const dynamic = "force-dynamic";

export default async function SourceMapPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const moved = editionRedirect(query);
  if (moved) redirect(moved);
  const params = new URLSearchParams();
  for (const key of ["location", "tab", "run"]) if (typeof query[key] === "string") params.set(key, query[key]);
  const tab = params.get("tab") === "runs" ? "runs" : "sources";
  const principal = await currentPrincipal().catch(() => null);
  // Called directly, so the page is the shell it chose (the workspace, or the gated map layout).
  return await InternalMapPage({
    page: "source-map", title: "Source map", description: "Every location's sources and source runs. Read-only.",
    returnTo: `/source-map?${params}`, unlock: typeof query.unlock === "string" ? query.unlock : undefined,
    children: <SourceReview locationId={params.get("location") ?? ""} tab={tab} runId={params.get("run")} signedIn={Boolean(principal)} />,
  });
}
