import type { LocationProfile } from "./types";
import { addressKey } from "../communities/venues";
import { withinArea, type Point } from "../../../../shared/geography";

export function mentions(text: string | null | undefined, name: string | null | undefined): boolean {
  if (!text || !name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text);
}
export type CommunityEvidence = { method: "community_mention" | "selected_venue" | "boundary" | "approximate_area"; matches: string[] };
export function communityEvidence(location: LocationProfile, texts: Array<string | null | undefined>, coordinates?: Point): CommunityEvidence | null {
  const community = location.community;
  if (!community) return null;
  const matches = [...new Set([community.name, ...community.coverage_terms])].filter((term) => texts.some((text) => mentions(text, term)));
  if (matches.length) return { method: "community_mention", matches };
  const area = community.geography?.area;
  if (area && coordinates && withinArea(area, [community.longitude, community.latitude], coordinates)) {
    return { method: area.method === "boundary" ? "boundary" : "approximate_area", matches: [`${coordinates[1]}, ${coordinates[0]}`] };
  }
  const venue = location.systems.flatMap((system) => system.branches).find((branch) => texts.some((text) => {
    const address = addressKey(branch.address);
    return mentions(text, branch.name) || (address.length > 5 && ` ${addressKey(text ?? "")} `.includes(` ${address} `));
  }));
  return venue ? { method: "selected_venue", matches: [venue.name, venue.address] } : null;
}
