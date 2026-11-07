/** Citywide authority directories, not neighborhood source seeds. Every destination is
 * extracted from live directory content; collection still checks each item's locality. */
import { parseHTML } from "linkedom";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { distanceKm, type Point } from "../../../../shared/geography";
import { pageLinks, type PageLink } from "../connectors/ai-discovery";
import { mentions } from "../connectors/community";
import { httpsLink } from "../connectors/common";
import { Fetcher } from "../connectors/fetcher";
import { publicSourceTransport } from "../connectors/public-http";
import { locationCenter, townName } from "../connectors/locality";
import { mainText } from "../connectors/web/page";
import { normaliseUrl, webSourceId, type SourceCandidate } from "../sourcemap/store";
import type { SectionId } from "../sourcemap/sections";
import { recordDecision } from "../trace/decisions";
import type { DiscoveryContext, MethodDefinition } from "./methods";

export const SEATTLE_DIRECTORIES = {
  schools: "https://www.seattleschools.org/schools/",
  libraries: "https://www.spl.org/hours-and-locations",
  organizations: "https://www.seattle.gov/neighborhoods/community-connections/community-engagement/community-engagement-coordinators",
};
const HTML = "text/html, application/xhtml+xml";
const MAX_BYTES = 3 * 1024 * 1024;
export const LIBRARY_SERVING_KM = 3;

export function schoolLinks(html: string, directory: string, place: string): PageLink[] {
  const { document } = parseHTML(html);
  return Array.from(document.querySelectorAll(".list-item")).flatMap(card => {
    const name = card.querySelector(".list-item-title")?.textContent?.trim() ?? "";
    if (!mentions(name, place)) return [];
    return pageLinks(card.innerHTML, directory, 20).filter(link => {
      const host = new URL(link.url).hostname;
      return host.endsWith(".seattleschools.org") && host !== "www.seattleschools.org" && new URL(link.url).pathname === "/";
    }).map(link => ({ ...link, text: name }));
  });
}

export function branchPoint(html: string): Point | null {
  const { document } = parseHTML(html);
  const marker = document.querySelector("[data-map-markerlat][data-map-markerlng]");
  if (!marker) return null;
  const lat = Number(marker.getAttribute("data-map-markerlat")), lon = Number(marker.getAttribute("data-map-markerlng"));
  return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

/** Link annotation rectangles bind the visible organization name to its actual URL. */
export async function organizationLinks(bytes: Uint8Array, place: string): Promise<PageLink[]> {
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Directory is not a PDF");
  (globalThis as typeof globalThis & { pdfjsWorker?: { WorkerMessageHandler: typeof WorkerMessageHandler } }).pdfjsWorker ??= { WorkerMessageHandler };
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true, disableFontFace: true, isEvalSupported: false });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 12) throw new Error("Directory exceeds 12-page budget");
    const links: PageLink[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), content = await page.getTextContent();
      for (const annotation of await page.getAnnotations()) {
        if (!annotation.url || !Array.isArray(annotation.rect)) continue;
        const [left, bottom, right, top] = annotation.rect;
        const text = content.items.filter(item => "str" in item && item.transform[4] >= left - 2 && item.transform[4] <= right + 2 && item.transform[5] >= bottom - 2 && item.transform[5] <= top + 2).map(item => "str" in item ? item.str : "").join(" ").trim();
        const url = httpsLink(String(annotation.url).replace(/^http:/, "https:"));
        if (url && mentions(text, place)) links.push({ url, text });
      }
    }
    return links;
  } finally { await task.destroy(); }
}

/** Only observed navigation on this institution's host; keep branch paths scoped. */
export function institutionPages(html: string, root: string, branch = false): PageLink[] {
  const base = new URL(root);
  return pageLinks(html, root, 600).filter(link => {
    const url = new URL(link.url);
    return url.hostname === base.hostname && (!branch || url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/"))
      && normaliseUrl(link.url) !== normaliseUrl(root) && !/\/20\d{2}\/|\.(pdf|jpg|png|zip)$/i.test(url.pathname)
      && /\b(calendar|events?|news|meetings?|newsletter)\b/i.test(link.text);
  }).sort((a, b) => Number(/^(calendar|events|news|meetings)$/i.test(b.text)) - Number(/^(calendar|events|news|meetings)$/i.test(a.text))).slice(0, 6);
}

export async function discoverSeattleDirectories(context: DiscoveryContext) {
  const city = context.location.community?.parent_name ?? townName(context.location);
  if (context.location.state !== "WA" || city.toLowerCase() !== "seattle") return { candidates: [], detail: "No authority-directory adapter for this jurisdiction" };
  const place = context.location.community?.name ?? townName(context.location);
  const { center } = locationCenter(context.location);
  const fetcher = new Fetcher(publicSourceTransport(context.transport));
  const candidates: SourceCandidate[] = [], seen = new Set<string>();
  const failures: string[] = [];
  const deadline = Date.now() + 240_000;
  const checkBudget = () => { if (Date.now() >= deadline) throw new Error("Directory discovery time budget exhausted"); };
  async function rejected(url: string, error: unknown) {
    failures.push(`${url}: ${String(error)}`);
    await recordDecision({ stage: "source", actor: "rule", subject: url, decision: "rejected", reason: String(error), rule: "authority_directory" });
  }
  async function add(link: PageLink, directory: string, section: SectionId, reason: string, prefetched?: string, branch = false) {
    if (seen.has(normaliseUrl(link.url))) return;
    checkBudget();
    try {
      const [url, html] = prefetched === undefined ? await fetcher.getText(link.url, MAX_BYTES, HTML) : [link.url, prefetched];
      if ((mainText(html) ?? "").length < 120) throw new Error("No substantive institution page");
      const key = normaliseUrl(url);
      if (seen.has(key)) return;
      seen.add(key);
      const candidate: SourceCandidate = { source_id: webSourceId(url), name: link.text.slice(0, 120), url, reader: "web", section,
        params: { url, section, kind: "local_news", inside_area: false, discovery_parent_url: directory, directory_selection: reason },
        found_by: { method: "directories", detail: `${directory} → ${url}; ${reason}` }, inside_area: false, source_kind: "listing" };
      candidates.push(candidate);
      for (const child of institutionPages(html, url, branch)) {
        checkBudget();
        try {
          const [final, body] = await fetcher.getText(child.url, MAX_BYTES, HTML);
          if (seen.has(normaliseUrl(final))) continue;
          if ((mainText(body) ?? "").length < 120) throw new Error("No substantive linked page");
          seen.add(normaliseUrl(final));
          candidates.push({ ...candidate, source_id: webSourceId(final), name: `${link.text}: ${child.text}`.slice(0, 120), url: final,
            params: { ...candidate.params, url: final, discovery_parent_url: url, authority_directory_url: directory },
            found_by: { method: "directories", detail: `${directory} → ${url} → ${final}; ${reason}` } });
        } catch (error) { await rejected(child.url, error); }
      }
      // A PTA is a distinct organization, so record its observed outbound link separately.
      if (section === "schools") for (const pta of pageLinks(html, url, 600).filter(l => /\bPT[AS]A?\b/i.test(l.text) && new URL(l.url).hostname !== new URL(url).hostname).slice(0, 2)) {
        await add(pta, url, "community", "PTA link on directory-selected school website");
      }
    } catch (error) { await rejected(link.url, error); }
  }
  try {
    const [url, html] = await fetcher.getText(SEATTLE_DIRECTORIES.schools, MAX_BYTES, HTML);
    for (const link of schoolLinks(html, url, place).slice(0, 4)) await add(link, url, "schools", `School name matches ${place}`);
  } catch (error) { await rejected(SEATTLE_DIRECTORIES.schools, error); }
  try {
    const [url, html] = await fetcher.getText(SEATTLE_DIRECTORIES.libraries, MAX_BYTES, HTML);
    const branches = pageLinks(html, url, 600).filter(l => new URL(l.url).hostname === new URL(url).hostname && /^\/hours-and-locations\/[^/]+-branch\/?$/.test(new URL(l.url).pathname));
    const nearby: Array<{ link: PageLink; html: string; km: number }> = [];
    if (center) for (const branch of branches.slice(0, 40)) {
      checkBudget();
      try {
        const [final, body] = await fetcher.getText(branch.url, MAX_BYTES, HTML), point = branchPoint(body);
        if (point) { const km = distanceKm(center, point); if (km <= LIBRARY_SERVING_KM) nearby.push({ link: { ...branch, url: final }, html: body, km }); }
      } catch (error) { await rejected(branch.url, error); }
    }
    for (const branch of nearby.sort((a, b) => a.km - b.km).slice(0, 2)) await add(branch.link, url, "events", `Nearby serving branch: ${branch.km.toFixed(2)} km from location center; official branch coordinates; not assumed inside neighborhood`, branch.html, true);
  } catch (error) { await rejected(SEATTLE_DIRECTORIES.libraries, error); }
  try {
    checkBudget();
    const [url, html] = await fetcher.getText(SEATTLE_DIRECTORIES.organizations, MAX_BYTES, HTML);
    const baseHref = parseHTML(html).document.querySelector("base[href]")?.getAttribute("href");
    const documentBase = baseHref ? new URL(baseHref, url).toString() : url;
    const docs = pageLinks(html, documentBase, 600).filter(l => new URL(l.url).hostname === new URL(url).hostname && /\/Districts\/.*\.pdf$/i.test(new URL(l.url).pathname)).slice(0, 10);
    for (const doc of docs) {
      checkBudget();
      try {
        const [final, bytes] = await fetcher.get(doc.url, MAX_BYTES, "application/pdf");
        for (const link of (await organizationLinks(bytes, place)).slice(0, 8)) await add(link, final, "community", `Official directory's linked organization name matches ${place}`);
      } catch (error) { await rejected(doc.url, error); }
    }
  } catch (error) { await rejected(SEATTLE_DIRECTORIES.organizations, error); }
  return { candidates, detail: `${candidates.length} institution endpoints from live authority directories; ${failures.length} rejected fetches; school name / nearby library / named organization selection` };
}

export const directories: MethodDefinition = { method: "directories", label: "Official institution directories", refreshDays: 30, run: discoverSeattleDirectories };
