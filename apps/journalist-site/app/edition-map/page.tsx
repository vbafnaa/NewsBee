import InternalMapPage from "../components/internal-map-page";
import EditionReview from "./edition-review";

export const dynamic = "force-dynamic";
export default async function EditionMapPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const params = new URLSearchParams();
  for (const key of ["location", "run", "view"]) if (typeof query[key] === "string") params.set(key, query[key]);
  // Called directly, so the page is the shell it chose (the workspace, or the gated map layout).
  return await InternalMapPage({
    page: "edition-map", title: "Edition map", description: "How each edition run went. Read-only.",
    returnTo: `/edition-map?${params}`, unlock: typeof query.unlock === "string" ? query.unlock : undefined,
    children: <EditionReview locationId={params.get("location") ?? ""} runId={params.get("run")} view={params.get("view") === "compare" ? "compare" : "funnel"} />,
  });
}
