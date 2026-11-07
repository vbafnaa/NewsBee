/** Finds a working RSS/Atom feed for a website, through the robots-checked Fetcher. */
import { addDays, MAX_FEED_BYTES } from "../connectors/common";
import type { Fetcher } from "../connectors/fetcher";
import { advertisedFeeds } from "../connectors/feeds";
import { parseNewsFeed } from "../connectors/wider/adapters";
import { limit } from "../playbook";

export const FEED_GUESSES = ["/feed", "/feed/", "/rss", "/rss.xml", "/feeds/posts/default", "/?feed=rss2"];
export const MAX_REQUESTS = 4;
export const STALE_DAYS = limit("general.stop.feed_recent_days");
const ACCEPT_HTML = "text/html, application/xhtml+xml";
const ACCEPT_FEED = "application/rss+xml, application/atom+xml, application/xml, text/xml";

export type FoundFeed = { feed: string; latest: string; items: number };

/** The first advertised or conventional feed that parses and has an item in the last STALE_DAYS. */
export async function findFeed(fetcher: Fetcher, website: string, today: string): Promise<FoundFeed | null> {
  let requests = 0;
  const candidates: string[] = [];
  try {
    requests += 1;
    const [page, html] = await fetcher.getText(website, 2 * 1024 * 1024, ACCEPT_HTML);
    candidates.push(...advertisedFeeds(html, page));
    candidates.push(...FEED_GUESSES.map((path) => new URL(path, page).toString()));
  } catch { return null; }
  for (const url of [...new Set(candidates)]) {
    if (requests >= MAX_REQUESTS) break;
    requests += 1;
    try {
      const [final, bytes] = await fetcher.get(url, MAX_FEED_BYTES, ACCEPT_FEED);
      const items = parseNewsFeed(bytes);
      const latest = items.map((item) => item.published_day).sort().at(-1);
      if (latest && latest >= addDays(today, -STALE_DAYS)) return { feed: final, latest, items: items.length };
    } catch { /* Not a feed, or not allowed; try the next candidate. */ }
  }
  return null;
}
