import seed from "../config/communities.json";
import type { GeographicPlace } from "./geography";

export type Community = {
  name: string;
  state: string;
  state_name: string;
  parent_id: string;
  parent_name: string;
  latitude: number;
  longitude: number;
  aliases: string[];
  coverage_terms: string[];
  library_branches: string[];
  newsrooms: Array<{ name: string; feed: string }>;
  geography?: GeographicPlace;
  parent_kind?: "city" | "county" | null;
};

export const COMMUNITY_SEED = seed;

export function communityDirectory(value: unknown): Record<string, Community> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("communities must map IDs to reviewed communities");
  for (const [id, raw] of Object.entries(value)) {
    const entry = raw as Partial<Community> | null;
    const invalid = () => new Error(`communities entry ${id} needs a name, state, parent, coordinates, aliases, coverage terms, library branches and HTTPS news feeds`);
    if (!entry || typeof entry !== "object" || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(id) ||
      typeof entry.name !== "string" || !entry.name.trim() || typeof entry.state !== "string" || !/^[A-Z]{2}$/.test(entry.state) ||
      typeof entry.state_name !== "string" || !entry.state_name.trim() ||
      typeof entry.parent_id !== "string" || !entry.parent_id.endsWith(`-${entry.state.toLowerCase()}`) ||
      !id.endsWith(`-${entry.parent_id}`) || typeof entry.parent_name !== "string" || !entry.parent_name.trim() ||
      typeof entry.latitude !== "number" || !Number.isFinite(entry.latitude) || Math.abs(entry.latitude) > 90 ||
      typeof entry.longitude !== "number" || !Number.isFinite(entry.longitude) || Math.abs(entry.longitude) > 180) throw invalid();
    for (const field of ["aliases", "coverage_terms", "library_branches"] as const) {
      const list = entry[field];
      if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item.trim())) throw invalid();
    }
    if (!entry.coverage_terms?.length || !Array.isArray(entry.newsrooms)) throw invalid();
    for (const newsroom of entry.newsrooms) {
      if (!newsroom || typeof newsroom.name !== "string" || !newsroom.name.trim() || typeof newsroom.feed !== "string") throw invalid();
      let url: URL;
      try { url = new URL(newsroom.feed); } catch { throw invalid(); }
      if (url.protocol !== "https:" || url.username || url.password) throw invalid();
    }
  }
  return value as Record<string, Community>;
}

export function communityName(community: Community) {
  return `${community.name}, ${community.parent_name}, ${community.state}`;
}

export function matchingCommunities(communities: Record<string, Community>, query: string, state?: string) {
  const parts = query.toLowerCase().trim().split(/\s*,\s*/);
  const name = parts.shift() ?? "";
  return Object.entries(communities).filter(([, community]) =>
    (!state || community.state === state.toUpperCase()) &&
    [community.name, ...community.aliases].some((label) => {
      const base = label.toLowerCase();
      return [base, `${base} ${community.state.toLowerCase()}`, `${base} ${community.parent_name.toLowerCase()}`,
        `${base} ${community.state_name.toLowerCase()}`, `${base} ${community.parent_name.toLowerCase()} ${community.state_name.toLowerCase()}`,
        `${base} ${community.parent_name.toLowerCase()} ${community.state.toLowerCase()}`].some((candidate) => candidate.startsWith(name));
    }) &&
    parts.every((part) => community.state.toLowerCase().startsWith(part) || community.state_name.toLowerCase().startsWith(part) || community.parent_name.toLowerCase().startsWith(part)));
}
