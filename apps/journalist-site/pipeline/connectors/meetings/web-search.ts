/** Optional search-index discovery. Results are leads, never meeting facts. */
import type { HttpTransport } from "../../core/http";
import type { Logger } from "../../core/log";
import { logApiCall, paidRefusal } from "../../trace/gateway";
import { httpsLink } from "../common";

const ENDPOINT = "https://api.tavily.com/search";

export type SearchHit = { url: string; title: string };

export async function searchCouncilDocuments(
  transport: HttpTransport, apiKey: string, website: string, town: string, year: string, log: Logger,
): Promise<{ hits: SearchHit[]; error?: string }> {
  const host = new URL(website).hostname.replace(/^www\./, "");
  const query = `site:${host} "${town}" city council minutes agenda ${year}`;
  const refused = await paidRefusal("tavily");
  if (refused) return { hits: [], error: refused };
  await logApiCall("tavily", true, "ok", query);
  try {
    const response = await transport({
      url: ENDPOINT,
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, search_depth: "basic", max_results: 10, include_domains: [host], include_domains_mode: "restrict", include_answer: false, include_raw_content: false }),
      maxBytes: 256 * 1024,
      timeoutMs: 8000,
    });
    if (response.status !== 200) throw new Error(`Search API returned HTTP ${response.status}`);
    const data: unknown = JSON.parse(new TextDecoder().decode(response.body));
    const found = (data as { results?: unknown } | null)?.results;
    if (!Array.isArray(found)) throw new Error("Search API response has no results");
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const hit of found.slice(0, 10)) {
      if (!hit || typeof hit !== "object" || typeof hit.url !== "string") continue;
      const safe = httpsLink(hit.url);
      if (!safe) continue;
      const parsed = new URL(safe);
      const hostname = parsed.hostname.replace(/^www\./, "");
      if (hostname !== host && !hostname.endsWith(`.${host}`)) continue;
      const canonical = parsed.toString().split("#")[0];
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      hits.push({ url: canonical, title: typeof hit.title === "string" ? hit.title.slice(0, 200) : "" });
    }
    return { hits };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("council_web_search_unavailable", { website, error: message });
    return { hits: [], error: message };
  }
}
