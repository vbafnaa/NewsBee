import type { Fetcher } from "../connectors/fetcher";
import { mentions } from "../connectors/community";
import { mainText } from "../connectors/web/page";
import { normaliseUrl, webSourceId, type SourceCandidate } from "../sourcemap/store";
import { isSection } from "../sourcemap/sections";
import { inspectPage, siteLinks } from "./inspect";

/** Follow observed navigation, never guessed paths. Keep each calendar/news/project page
 * separate from its parent; a shared feed must not collapse distinct source pages. */
export async function linkedPages(
  fetcher: Pick<Fetcher, "getText">, parent: SourceCandidate, html: string,
  today: string, place: string, cap = 4,
): Promise<{ candidates: SourceCandidate[]; rejected: Array<{ url: string; reason: string }> }> {
  const candidates: SourceCandidate[] = [], rejected: Array<{ url: string; reason: string }> = [];
  if (!parent.url) return { candidates, rejected };
  const links = siteLinks(html, parent.url, 40).sort((a, b) =>
    Number(mentions(`${b.title} ${b.url}`, place)) - Number(mentions(`${a.title} ${a.url}`, place)));
  const seen = new Set([normaliseUrl(parent.url)]);
  for (const link of links.slice(0, cap)) {
    try {
      const [url, content] = await fetcher.getText(link.url, 2 * 1024 * 1024, "text/html, application/xhtml+xml");
      const key = normaliseUrl(url);
      if (seen.has(key)) continue;
      seen.add(key);
      // Soft errors and empty navigation shells are not useful endpoints.
      if ((mainText(content) ?? "").length < 120) { rejected.push({ url, reason: "No substantive page text" }); continue; }
      const inspection = inspectPage(content, url, today, null);
      if (!inspection.fresh && inspection.dated >= 3 && inspection.kind !== "lookup") {
        rejected.push({ url, reason: `No recent dates (latest ${inspection.latest ?? "unknown"})` }); continue;
      }
      const section = isSection(link.section) ? link.section : parent.section;
      candidates.push({
        source_id: webSourceId(url), name: `${parent.name}: ${link.title || section}`.slice(0, 120),
        url, feed_url: null, reader: "web", section,
        params: { url, section, inside_area: false, discovery_parent_url: parent.url,
          kind: section === "obituaries" ? "obituary" : section === "sports" ? "school_sports" : "local_news" },
        found_by: { method: parent.found_by.method, detail: `Navigation from ${parent.url}: ${link.title}` },
        // Being linked by a local site does not make every event or story local.
        inside_area: false, source_kind: inspection.kind, latest_day: inspection.latest,
        link_only: inspection.kind === "lookup" || !inspection.fresh,
      });
    } catch (error) { rejected.push({ url: link.url, reason: String(error) }); }
  }
  return { candidates, rejected };
}
