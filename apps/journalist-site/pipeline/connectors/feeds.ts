import { httpsLink } from "./common";

/** Feeds a page advertises with <link rel="alternate" type=...>, absolute and HTTPS. */
export function advertisedFeeds(html: string, pageUrl: string): string[] {
  const feeds: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1] ?? "";
    if (!/\balternate\b/i.test(attr("rel"))) continue;
    if (!/(rss|atom|calendar)/i.test(attr("type"))) continue;
    if (/comments/i.test(attr("title")) || /\/comments\//i.test(attr("href"))) continue;
    try { const url = httpsLink(new URL(attr("href"), pageUrl).toString()); if (url && !feeds.includes(url)) feeds.push(url); } catch { /* ignore bad hrefs */ }
  }
  return feeds;
}

