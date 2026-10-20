import { Parser } from "htmlparser2";
import type { Community } from "../../../../shared/community-directory";
import type { HttpTransport } from "../core/http";
import { Fetcher } from "../connectors/fetcher";
import { publicSourceTransport } from "../connectors/public-http";
import { MAX_FEED_BYTES, httpsLink } from "../connectors/common";
import { parseNewsFeed } from "../connectors/wider/adapters";
import { lookupWebsite } from "./wikidata";
import { logger } from "../core/log";

const log = logger("communities.news-discovery");
export function feedLinks(html: string, page: string): string[] {
  const links: string[] = [];
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (tag !== "link" || !/\balternate\b/i.test(attrs.rel ?? "") || !/^(application\/(?:rss|atom)\+xml|text\/xml)$/i.test(attrs.type ?? "")) return;
      try {
        const url = httpsLink(new URL(attrs.href ?? "", page).toString());
        if (url) links.push(url);
      } catch { /* Ignore malformed optional feed links. */ }
    },
  });
  parser.end(html);
  return [...new Set(links)].slice(0, 3);
}

/** Only retain feeds actually linked by a resolved community website and parsed successfully. */
export async function discoverCommunityNews(transport: HttpTransport, community: Community) {
  const gaps: string[] = [], newsrooms = [...community.newsrooms];
  if (newsrooms.length) return { newsrooms, gaps };
  try {
    const website = community.geography?.website
      ?? (await lookupWebsite(transport, community.name, community.latitude, community.longitude)).website;
    if (!website) return { newsrooms, gaps: ["No community website could be resolved for automatic RSS/Atom discovery."] };
    const fetcher = new Fetcher(publicSourceTransport(transport));
    const [page, html] = await fetcher.getText(website, 1024 * 1024, "text/html");
    const links = feedLinks(html, page);
    for (const feed of links) {
      try {
        const [, bytes] = await fetcher.get(feed, MAX_FEED_BYTES, "application/rss+xml,application/atom+xml,application/xml");
        parseNewsFeed(bytes);
        newsrooms.push({ name: `${community.name} community website`, feed });
      } catch (error) {
        log.warn("community_feed_unusable", { feed, error: String(error) });
        gaps.push(`Community feed could not be validated: ${feed}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!links.length) gaps.push(`No supported RSS/Atom link was published on ${page}.`);
  } catch (error) {
    log.warn("community_news_discovery_unavailable", { community: community.name, error: String(error) });
    gaps.push(`Community news discovery unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { newsrooms, gaps };
}
