import { notFound } from "next/navigation";
import SampleMap from "./sample-map";

export const dynamic = "force-dynamic";
export default function UsageMapPreview() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <main className="panel">
    <h1>Interactive usage map — isolated sample preview</h1>
    <p className="notice">Fictional counts only. No database, credentials, map APIs or administrator access. Sample activity is on October 1 and 2, 2026; date filters work on these two days. This route is unavailable outside development.</p>
    <SampleMap />
  </main>;
}
