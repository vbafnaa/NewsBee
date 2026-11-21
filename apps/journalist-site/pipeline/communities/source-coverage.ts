import type { LocationProfile } from "../connectors/types";
import { areaLabel } from "../../../../shared/geography";
import type { Db } from "mongodb";
import { sourceMap, type SourceRecord } from "../sourcemap/store";
import { inheritedAccessReview, reviewAllowsCollection } from "../sourcemap/source-review";

/** Read-only alias reconciliation: readiness must not grant an alternate endpoint access. */
export async function sourceEvidenceByLocation(db: Db, ids: string[]) {
  const records = ids.length ? await sourceMap(db).find({ location_id: { $in: ids } }).toArray() : [];
  const grouped = new Map<string, SourceRecord[]>();
  for (const record of records) {
    const sources = grouped.get(record.location_id) ?? [];
    sources.push(record);
    grouped.set(record.location_id, sources);
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const [id, sources] of grouped) {
    grouped.set(id, sources.filter((source) => ["active", "pinned"].includes(source.status)
      && source.review?.decision !== "reject" && !source.link_only
      && !inheritedAccessReview(source, sources)
      && reviewAllowsCollection(source.access_review, today)));
  }
  return grouped;
}

export function sourceCoverage(profile: LocationProfile, discoveryGaps: string[] = [], manual: string[] = [], evidence?: SourceRecord[]): LocationProfile["source_coverage"] {
  if (!profile.community && evidence === undefined) return undefined;
  const publisherReady = evidence?.some((source) => source.reader === "web" && source.section === "news"
    && (source.source_tier === "local_reporting" || source.source_kind === "feed" || source.source_kind === "news_report"
      || source.params?.kind === "news_report" || source.review?.decision === "accept"
      || source.status === "pinned" && ["editor", "reader_suggestion"].includes(source.found_by?.method)));
  const libraryReady = evidence?.some((source) => source.reader === "library"
    && profile.systems.some((system) => system.branches.length
      && system.fscskey === (source.params?.fscskey ?? source.params?.system_id
        ?? (source.source_id.startsWith("library:") ? source.source_id.slice("library:".length) : null))));
  const governmentReady = evidence
    ? evidence.some((source) => source.reader === "meetings" || source.section === "civic" && source.source_tier === "official")
    : !!profile.government?.tenant && ["detected", "override"].includes(profile.government.status);
  const gaps = discoveryGaps.filter((gap) => !(
    publisherReady && /^(No community website could be resolved|No supported RSS\/Atom link was published|Community feed could not be validated|Community news discovery unavailable)/.test(gap)
    || libraryReady && /^Library website discovery unavailable/.test(gap)
    || governmentReady && /^Government discovery unavailable/.test(gap)
  ));
  const geography = profile.community?.geography;
  if (geography && geography.area.method !== "boundary") gaps.push(`${areaLabel(geography.area)}. Review branch selection when using library sources.`);
  if (profile.community) {
    if (!profile.systems.some((system) => system.branches.length)) gaps.push("No library branches were identified in this community's coverage area.");
    if (!libraryReady && profile.systems.some((system) => !system.website)) gaps.push("One or more library systems have no resolved website.");
    if (evidence && !libraryReady && profile.systems.some((system) => system.branches.length)) gaps.push("Add or resume a readable library source in Sources.");
    if (!(evidence ? governmentReady : manual.includes("meetings") || governmentReady)) gaps.push("No supported meeting source is ready; add a validated meeting link or accept an official council agenda source in Sources.");
    if (!(evidence ? publisherReady : manual.includes("statenews") || profile.community.newsrooms.length)) gaps.push("No community RSS/Atom feed or validated publisher is ready; add a validated publisher link in Sources.");
  }
  const localSources = evidence ? evidence.length > 0
    : governmentReady || profile.systems.some((system) => system.website && system.branches.length) || !!profile.community?.newsrooms.length || manual.length > 0;
  return {
    status: !localSources ? "no_local_sources" : gaps.length ? "partial" : "ready",
    area: geography ? areaLabel(geography.area) : "Reviewed library branches and community coverage terms",
    gaps: [...new Set(gaps)], discovery_gaps: discoveryGaps, checked_at: new Date().toISOString(),
  };
}
