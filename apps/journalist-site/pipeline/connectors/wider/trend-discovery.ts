import type { ConnectorContext } from "../types";
import { MAX_FEED_BYTES } from "../common";
import { mentions, trendTier, type Region } from "./regions";

export type ReportingSearch = { topic: string; query: string };
export const quoteSearch = (text: string) => `"${text.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;
const distinct = (values: string[]) => [...new Map(values.filter((value) => value.trim()).map((value) => [value.trim().toLowerCase(), value.trim()])).values()];

export function reportingQualifier(place: Region) {
  const community = place.community_location?.community;
  return community?.parent_name.trim() && community.parent_name.toLowerCase() !== community.name.toLowerCase()
    ? community.parent_name : place.state_name ?? place.state_code;
}

/** Derive a bounded plan from onboarding evidence, never a hand-maintained city/topic list. */
export function reportingSearches(place: Region): ReportingSearch[] {
  const community = place.community_location?.community;
  const identities = community
    ? distinct([community.name, ...community.coverage_terms, ...community.aliases])
    : [place.town, ...place.nearby].slice(0, 5);
  const venues = community ? distinct((place.community_location?.systems ?? []).flatMap((system) => system.branches.map((branch) => branch.name))) : [];
  const topics = community ? distinct([...identities.slice(0, 4), ...venues.slice(0, 2)]) : identities;
  return topics.map((topic) => ({ topic, query: `${quoteSearch(topic)} ${quoteSearch(reportingQualifier(place))}` }));
}

/** Resolve real encyclopedia titles; community names are not municipal Wikipedia slugs. */
export async function communityWikiTopics(context: ConnectorContext, place: Region) {
  if (!place.community_location?.community) throw new Error("Community topic discovery requires a community profile");
  const search = reportingSearches(place)[0];
  const params = new URLSearchParams({
    action: "query", generator: "search", gsrsearch: search.query, gsrnamespace: "0", gsrlimit: "5",
    prop: "extracts", exintro: "1", explaintext: "1", exchars: "1500", format: "json",
  });
  const [, bytes] = await context.fetcher.get(`https://en.wikipedia.org/w/api.php?${params}`, MAX_FEED_BYTES, "application/json");
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || typeof data !== "object" || "error" in data) throw new Error("Invalid Wikipedia community topic response");
  const query = "query" in data ? data.query : undefined;
  if (query === undefined && "batchcomplete" in data) return [];
  if (!query || typeof query !== "object" || !("pages" in query) || !query.pages || typeof query.pages !== "object" || Array.isArray(query.pages)) {
    throw new Error("Invalid Wikipedia community pages");
  }
  const qualifier = reportingQualifier(place);
  return Object.values(query.pages).flatMap((page: unknown) => {
    if (!page || typeof page !== "object" || !("title" in page) || typeof page.title !== "string" || !("extract" in page) || typeof page.extract !== "string") return [];
    const text = `${page.title} ${page.extract}`;
    if (!mentions(text, qualifier) || !trendTier(place, page.title, page.extract)) return [];
    return [{ article: page.title.replaceAll(" ", "_"), about: page.extract, place: place.town }];
  });
}
