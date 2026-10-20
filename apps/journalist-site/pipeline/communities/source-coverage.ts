import type { LocationProfile } from "../connectors/types";
import { areaLabel } from "../../../../shared/geography";

export function sourceCoverage(profile: LocationProfile, discoveryGaps: string[] = [], manual: string[] = []): LocationProfile["source_coverage"] {
  if (!profile.community) return undefined;
  const gaps = [...discoveryGaps];
  const geography = profile.community.geography;
  const governmentReady = !!profile.government?.tenant && ["detected", "override"].includes(profile.government.status);
  if (geography && geography.area.method !== "boundary") gaps.push(`${areaLabel(geography.area)}. Review branch selection before publication.`);
  if (!profile.systems.some((system) => system.branches.length)) gaps.push("No library branches were identified in this community's coverage area.");
  if (profile.systems.some((system) => !system.website)) gaps.push("One or more library systems have no resolved website.");
  if (!manual.includes("meetings") && !governmentReady) gaps.push("No supported government meeting feed is ready.");
  if (!manual.includes("statenews") && !profile.community.newsrooms.length) gaps.push("No community RSS/Atom feed was found. State feeds still require explicit community relevance; add a validated publisher link in Sources.");
  const localSources = governmentReady || profile.systems.some((system) => system.website && system.branches.length) || !!profile.community.newsrooms.length || manual.length > 0;
  return {
    status: !localSources ? "no_local_sources" : gaps.length ? "partial" : "ready",
    area: geography ? areaLabel(geography.area) : "Reviewed library branches and community coverage terms",
    gaps: [...new Set(gaps)], discovery_gaps: discoveryGaps, checked_at: new Date().toISOString(),
  };
}
