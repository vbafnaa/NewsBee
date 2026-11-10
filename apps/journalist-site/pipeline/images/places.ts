import type { Story } from "../editions/stories";

export type PhotoPlace = { role: "venue" | "area"; name: string; queries: string[] };

/** Use an event's named venue or a permit's actual street, never its source's address. */
export function contextPlace(story: Story): PhotoPlace | null {
  const venue = story.first.venue?.trim();
  if (!venue || /^(online|virtual|zoom|tba|various locations|seattle|washington)$/i.test(venue)) return null;
  if (story.kind === "event" || story.kind === "meeting_preview") {
    const name = venue.split(/,\s*(?:\d|lower meadow|meeting room|room\b)/i)[0].trim();
    const queries = [name];
    if (/\bBranch$/i.test(name)) queries.push(name.replace(/\bBranch$/i, "Library"));
    return { role: "venue", name, queries };
  }
  if (story.kind !== "development" && story.kind !== "building_permit") return null;
  // Ordinal street names only: a broad neighborhood or a private property's name is insufficient.
  const name = venue.replace(/^\d+\s+block\s+of\s+/i, "").replace(/^\d+\s+(?=[A-Z]{1,2}\s+\d)/i, "");
  if (!/\b\d+(?:st|nd|rd|th)\b/i.test(name) || !/\b(?:st(?:reet)?|ave(?:nue)?|rd|road|way|blvd|boulevard)\b/i.test(name)) return null;
  const ordinal = (value: string) => value.replace(/\b(\d+)(ST|ND|RD|TH)\b/gi, (_, n, suffix) => n + suffix.toLowerCase());
  const full = ordinal(name.replace(/\bST\b/gi, "Street").replace(/\bAVE\b/gi, "Avenue").replace(/\bRD\b/gi, "Road"));
  return { role: "area", name: full, queries: [...new Set([full, ordinal(name)])] };
}
