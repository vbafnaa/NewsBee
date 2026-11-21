"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import SourceRuns from "@/app/source-map/source-runs";
import { PublicationScope } from "@/app/components/publication-scope";
import { sourceMapHref } from "../../newsroom-routes";
import SourceTable from "./source-table";

type Community = { id: string; name: string };

/** A newsroom's view of one community's shared source map: Current sources and Collection runs. */
export default function NewsroomSourceMap({ publicationId, communities, locationId, tab, runId, operator }: {
  publicationId: string; communities: Community[]; locationId: string; tab: "sources" | "runs"; runId: string | null; operator: boolean;
}) {
  const router = useRouter();
  const community = communities.find((item) => item.id === locationId);
  return <PublicationScope publicationId={publicationId}>
    <div className="jw-source-toolbar">
      {communities.length > 1 && <label className="jw-community-picker">Community
        <select value={locationId} onChange={(event) => router.push(sourceMapHref(publicationId, event.target.value, tab))}>
          {communities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
      <nav className="jw-segmented jw-tabs" aria-label="Source map views">
        <Link href={sourceMapHref(publicationId, locationId)} aria-current={tab === "sources" ? "page" : undefined}>Current sources</Link>
        <Link href={sourceMapHref(publicationId, locationId, "runs")} aria-current={tab === "runs" ? "page" : undefined}>Collection runs</Link>
      </nav>
    </div>
    <p className="jw-shared-notice" role="note">
      <strong>Shared source map.</strong> Changes apply to every newsroom covering {community?.name ?? locationId}.
      Decisions and added sources are recorded with your name{operator ? "" : "; pausing sources and changing look-back windows stay with operators"}.
    </p>
    {tab === "sources"
      ? <SourceTable key={locationId} publicationId={publicationId} locationId={locationId} />
      : <SourceRuns locationId={locationId} runId={runId} canEdit locations={communities} liveLog={operator}
        routeFor={(location, run) => sourceMapHref(publicationId, location, "runs", run)} />}
  </PublicationScope>;
}
