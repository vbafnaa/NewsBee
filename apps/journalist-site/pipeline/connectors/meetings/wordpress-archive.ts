/** WordPress meeting archives that publish document metadata through a same-site JSON route. */
import type { Fetcher } from "../fetcher";
import { httpsLink } from "../common";

type Entry = { meeting_date?: unknown; meeting_type?: unknown; meeting_documents?: unknown };
export type ArchiveDocuments = { url: string; label: string }[];

/** Only use this endpoint when the official page itself advertises the matching archive widget. */
export function hasMeetingArchive(html: string) {
  return /dcbCustomRouteGet\s*\(\s*["']meeting["']\s*\)/.test(html) && /meeting-years--wrapper/.test(html) && /\bcity council\b/i.test(html);
}

export async function wordpressArchive(
  fetcher: Fetcher, pageUrl: string, website: string, today: string, window: [string, string], pastDays: number,
): Promise<{ links: ArchiveDocuments; endpoints: string[] }> {
  const url = new URL("/wp-json/dcb-custom-route/v1/archive/", pageUrl);
  url.searchParams.set("pod-name", "meeting");
  const host = new URL(website).hostname.replace(/^www\./, "");
  const past = new Date(`${today}T00:00:00Z`);
  past.setUTCDate(past.getUTCDate() - pastDays);
  const first = past.toISOString().slice(0, 10);
  const links: ArchiveDocuments = [];
  const endpoints: string[] = [];
  for (const year of new Set([first.slice(0, 4), window[1].slice(0, 4)])) {
    url.searchParams.set("year", year);
    const [endpoint, text] = await fetcher.getText(url.toString(), 512 * 1024, "application/json");
    if (new URL(endpoint).hostname.replace(/^www\./, "") !== host) throw new Error("Meeting archive redirected away from official website");
    endpoints.push(endpoint);
    // This particular WordPress plugin returns a JSON string containing serialized JSON.
    let parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid meeting archive response");
    for (const item of Object.values(parsed as Record<string, Entry>).slice(0, 150)) {
      if (!item || typeof item !== "object" || typeof item.meeting_date !== "string" || !/^20\d\d-\d\d-\d\d$/.test(item.meeting_date) || !Array.isArray(item.meeting_documents)) continue;
      const date = item.meeting_date;
      for (const document of item.meeting_documents.slice(0, 8)) {
        if (!document || typeof document !== "object") continue;
        const type = (document as Record<string, unknown>)["document-type"];
        const raw = (document as Record<string, unknown>)["document-guid"];
        if (type !== "Minutes" && type !== "Agenda" || typeof raw !== "string") continue;
        if (type === "Minutes" ? date < first || date >= today : date < window[0] || date > window[1]) continue;
        const safe = httpsLink(raw);
        if (!safe) continue;
        const hostname = new URL(safe).hostname.replace(/^www\./, "");
        if (hostname !== host) continue;
        links.push({ url: safe, label: `${type} ${date}` });
      }
    }
  }
  return { links: links.slice(0, 8), endpoints };
}
