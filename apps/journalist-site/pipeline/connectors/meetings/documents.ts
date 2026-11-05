/** Bounded, evidence-first fallback for councils publishing HTML/PDF instead of a supported API. */
import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { HttpStatusError } from "../../core/http";
import { Fetcher } from "../fetcher";
import { chooseLinks, pageLinks } from "../ai-discovery";
import { publicSourceTransport } from "../public-http";
import { FeedFormatError, httpsLink } from "../common";
import { sourceResult, type CollectedSource, type ConnectorContext, type SourceTask } from "../types";
import { bodyName, itemTitle, outcome, preview, type Meeting, type MeetingItem } from "./meetings";
import { searchCouncilDocuments } from "./web-search";
import { hasMeetingArchive, wordpressArchive } from "./wordpress-archive";

const PAGE_BYTES = 1024 * 1024;
const DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 3;
const MAX_DOCUMENTS = 8;
const MAX_PDF_PAGES = 12;
const DOCUMENT_PAST_DAYS = 35; // Minutes may be approved and published weeks after the meeting.
const COUNCIL = /\b(?:city|town|village|borough) council\b/i;
const DOCUMENT = /\b(agenda|minutes|meeting notes)\b/i;
const DECISION = /\b(approved|adopted|passed|rejected|denied|failed|tabled|postponed|carried|withdrawn)\b/i;

type Link = { url: string; label: string };
type Page = { url: string; text: string; lines: string[]; links: Link[] };

function parseHtml(html: string, page: string): Page {
  const lines: string[] = [], links: Link[] = [];
  let block = "", anchor: { href: string; label: string } | null = null, ignored = 0;
  const flush = () => { const line = block.replace(/\s+/g, " ").trim(); if (line) lines.push(line); block = ""; };
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (["script", "style", "nav", "footer"].includes(tag)) ignored++;
      if (ignored) return;
      if (["p", "li", "tr", "h1", "h2", "h3", "h4", "div", "br"].includes(tag)) flush();
      if (tag === "li") block = "• ";
      if (tag === "a" && attrs.href) anchor = { href: attrs.href, label: "" };
    },
    ontext(value) { if (!ignored) { block += ` ${value}`; if (anchor) anchor.label += ` ${value}`; } },
    onclosetag(tag) {
      if (["script", "style", "nav", "footer"].includes(tag)) { ignored = Math.max(0, ignored - 1); return; }
      if (ignored) return;
      if (tag === "a" && anchor) {
        try {
          const url = httpsLink(new URL(anchor.href, page).toString().split("#")[0]);
          if (url) links.push({ url, label: anchor.label.trim().replace(/\s+/g, " ") });
        } catch { /* Ignore malformed links. */ }
        anchor = null;
      }
      if (["p", "li", "tr", "h1", "h2", "h3", "h4", "div"].includes(tag)) flush();
    },
  }, { decodeEntities: true });
  parser.end(html);
  flush();
  return { url: page, text: lines.join("\n"), lines, links };
}

export async function pdfLines(bytes: Uint8Array): Promise<string[]> {
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new FeedFormatError("Meeting document is not a PDF");
  // PDF.js's Node fake worker otherwise imports ./pdf.worker.mjs relative to the
  // bundled Next server chunk, where that file does not exist in production.
  (globalThis as typeof globalThis & { pdfjsWorker?: { WorkerMessageHandler: typeof WorkerMessageHandler } }).pdfjsWorker ??= { WorkerMessageHandler };
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true, disableFontFace: true, isEvalSupported: false });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PDF_PAGES) throw new FeedFormatError("Meeting PDF exceeds page limit");
    const lines: string[] = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      let current = "", previousY: number | null = null;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform[5];
        if (previousY !== null && Math.abs(y - previousY) > 2) { if (current.trim()) lines.push(current.trim()); current = ""; }
        current += ` ${item.str}`;
        previousY = y;
        if (item.hasEOL) { if (current.trim()) lines.push(current.trim()); current = ""; previousY = null; }
      }
      if (current.trim()) lines.push(current.trim());
    }
    return lines;
  } finally { await task.destroy(); }
}

function dateIn(text: string): string | null {
  const iso = /\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/.exec(text);
  const us = /\b(0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])[/-](20\d{2})\b/.exec(text);
  const words = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i.exec(text);
  const year = iso?.[1] ?? us?.[3] ?? words?.[3];
  const month = iso?.[2] ?? us?.[1] ?? (words ? String(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(words[1].toLowerCase()) + 1) : null);
  const day = iso?.[3] ?? us?.[2] ?? words?.[2];
  if (!year || !month || !day) return null;
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? date : null;
}

function meetingFrom(lines: string[], url: string, label: string, town: string, today: string, window: [string, string]): ReturnType<typeof preview> {
  const heading = lines.slice(0, 12).join(" ");
  const header = lines.slice(0, 3).join(" ");
  if (!COUNCIL.test(heading) || (!heading.toLowerCase().includes(town.toLowerCase()) && !label.toLowerCase().includes(town.toLowerCase()))) return null;
  if (/\bagendas?\b/i.test(label) && /\bminutes\b/i.test(label)) return null;
  const kind = /\b(minutes|meeting notes)\b/i.test(header) ? "minutes" : /\bagenda\b/i.test(header) ? "agenda" :
    /\b(minutes|meeting notes)\b/i.test(label) ? "minutes" : /\bagenda\b/i.test(label) ? "agenda" :
    /\b(minutes|meeting notes)\b/i.test(heading) ? "minutes" : /\bagenda\b/i.test(heading) ? "agenda" : null;
  if (!kind) return null;
  const date = dateIn(heading) ?? dateIn(label);
  if (!date) return null;
  const past = new Date(`${today}T00:00:00Z`);
  past.setUTCDate(past.getUTCDate() - DOCUMENT_PAST_DAYS);
  if (kind === "agenda" ? date < window[0] || date > window[1] : date >= today || date < past.toISOString().slice(0, 10)) return null;
  const items: MeetingItem[] = [];
  const records = lines.slice(1, 150);
  for (let index = 0; index < records.length; index++) {
    const original = records[index];
    const text = original.replace(/^(?:\d+[.)]|[A-Z][.)]|[•\-*])\s+/, "").trim();
    if (!text || text.length > 250 || DOCUMENT.test(text) && dateIn(text)) continue;
    if (kind === "agenda" && !/^(?:\d+[.)]|[A-Z][.)]|[•\-*])\s+/.test(original)) continue;
    let decision = kind === "minutes" ? DECISION.exec(text)?.[1] ?? null : null;
    let subject = text;
    if (kind === "minutes" && /\bMOTION BY\b/i.test(text)) {
      let voteAt = index;
      while (voteAt < Math.min(records.length, index + 6) && !/\bmotion (?:carried|passed|failed)\b/i.test(records[voteAt])) voteAt++;
      const voted = voteAt < Math.min(records.length, index + 6);
      const span = records.slice(index, voted ? voteAt + 1 : Math.min(records.length, index + 6)).join(" ");
      const motion = /\bMOTION BY\b.*?\bto (approve|adopt|deny|reject) (.+?)(?:\.|$)/i.exec(span);
      if (!voted || !motion) continue; // A motion's intent is not its result.
      const action = motion[1].toLowerCase();
      decision = /\bmotion failed\b/i.test(span) ? "failed" : action === "deny" ? "denied" : action === "reject" ? "rejected" : action === "adopt" ? "adopted" : "approved";
      subject = motion[2].trim();
      if (/^(?:the |this )?(?:ordinance|resolution|contract|item|proposal|motion)\b/i.test(subject)) {
        const preceding = [...records.slice(Math.max(0, index - 5), index + 1)].reverse().find((line) => /^[A-Z][.)]\s+.*\b(ordinance|resolution|contract|agreement)\b/i.test(line));
        if (preceding) subject = preceding.replace(/^[A-Z][.)]\s+/, "").split(/\s+(?:Clerk|Attorney|Mayor|Councilmember)\b/i)[0].trim();
      }
      index = voteAt;
    } else if (kind === "minutes" && /\bmotion (?:carried|passed|failed)\b/i.test(text)) continue;
    if (kind === "minutes" && !decision) continue;
    const title = itemTitle(subject.replace(/\s*[-–:]\s*(approved|adopted|passed|rejected|denied|failed|tabled|postponed|carried|withdrawn)\b.*$/i, ""));
    if (title && title.length > 12 && !COUNCIL.test(title) && !/^(?:the )?consent agenda$/i.test(title)) items.push({ title, ...(decision ? { outcome: decision } : {}) });
  }
  if (!items.length) return null;
  const [year, month, day] = date.split("-").map(Number);
  const meeting: Meeting = { source_event_id: createHash("sha256").update(`${url}:${date}:${kind}`).digest("hex").slice(0, 20), body: bodyName("City Council"), start: { year, month, day }, source_url: url, items,
    ...(kind === "minutes" ? { minutes_final: /\b(approved|adopted|final) minutes\b/i.test(`${heading} ${label}`) } : {}) };
  return kind === "minutes" ? outcome(meeting, town) : preview(meeting, town);
}

function retryable(error: unknown) { return error instanceof HttpStatusError && (error.status === 429 || error.status >= 500); }
function sameSite(link: string, root: string) {
  const host = new URL(link).hostname.replace(/^www\./, ""), site = new URL(root).hostname.replace(/^www\./, "");
  return host === site || host.endsWith(`.${site}`);
}

/** Only follow links published by the city's official website; never guess a document URL. */
export async function collectCouncilDocuments(context: ConnectorContext, task: SourceTask, website: string, retry = true): Promise<CollectedSource> {
  const result = sourceResult(task.source_id, task.name, "no_feed", "No parseable city council agendas or minutes on the official website", { website, feed_kind: "council_documents", pages_checked: [], link_discovery: { method: "rules" } });
  const safeFetcher = new Fetcher(publicSourceTransport(context.transport));
  const pages: Page[] = [];
  const candidates = new Map<string, string>();
  let archivePage: string | null = null;
  const cached = retry ? await context.linkCache.get(context.location.id, task.source_id) : null;
  const cachedPage = cached?.kind === "council_documents" && sameSite(cached.url, website) ? cached.url : null;
  const queue = cachedPage ? [cachedPage] : [website];
  if (cachedPage) result.link_discovery = { method: "cache" };
  const visited = new Set<string>();
  async function crawl() {
    while (queue.length && pages.length < MAX_PAGES) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        const [final, html] = await safeFetcher.getText(url, PAGE_BYTES, "text/html");
        if (!sameSite(final, website)) continue;
        const page = parseHtml(html, final);
        pages.push(page);
        result.pages_checked.push(final);
        if (hasMeetingArchive(html)) {
          try {
            const archive = await wordpressArchive(safeFetcher, final, website, context.today, context.window, DOCUMENT_PAST_DAYS);
            result.pages_checked.push(...archive.endpoints);
            archivePage = final;
            for (const link of archive.links) candidates.set(link.url, /minutes[^<]{0,200}posted[^<]{0,150}approved by council/i.test(html) && link.label.startsWith("Minutes") ? `Approved ${link.label}` : link.label);
          } catch (error) { if (retryable(error)) throw error; result.archive_error = String(error); context.log.warn("council_archive_unavailable", { page: final, error: String(error) }); }
        }
        for (const link of page.links) {
          if (!sameSite(link.url, website) || visited.has(link.url) || queue.includes(link.url) || /\.pdf(?:\?|$)/i.test(link.url)) continue;
          const text = `${link.url} ${link.label}`;
          if (/\b(agenda|minutes|council|meeting)s?\b/i.test(text)) queue.unshift(link.url);
          else if (/\b(government|departments?|clerk)\b/i.test(text)) queue.push(link.url);
        }
        if (context.model && context.settings.aiLinkDiscovery && pages.length < MAX_PAGES) {
          const picks = await chooseLinks(context.model, "official city council agendas or minutes", final, pageLinks(html, final), context.log);
          for (const pick of picks) if (sameSite(pick, website) && !/\.pdf(?:\?|$)/i.test(pick) && !visited.has(pick) && !queue.includes(pick)) queue.push(pick);
        }
      } catch (error) { if (retryable(error)) throw error; context.log.warn("council_page_unavailable", { url, error: String(error) }); }
    }
  }
  await crawl();
  const town = context.location.community?.parent_name ?? context.location.name.split(",")[0];
  function addCandidates(from: Page[]) { for (const page of from) {
    for (const link of page.links) {
      const pdfOnCouncilPage = COUNCIL.test(page.text.slice(0, 1000)) && /\.pdf$/i.test(new URL(link.url).pathname) && /\b\d{1,2}[./-]\d{1,2}[./-](?:20)?\d{2}\b/.test(`${link.label} ${link.url}`);
      if (!DOCUMENT.test(`${link.label} ${link.url}`) && !pdfOnCouncilPage || candidates.has(link.url) || candidates.size >= 150) continue;
      if (!sameSite(link.url, website) && !/\.pdf(?:\?|$)/i.test(new URL(link.url).pathname)) continue;
      candidates.set(link.url, link.label);
    }
  } }
  addCandidates(pages);
  const events: NonNullable<ReturnType<typeof preview>>[] = [];
  const searchUrls = new Set<string>();
  const attempted = new Set<string>();
  async function collectCandidates(limit: number, only?: Set<string>) {
    const ordered = [...candidates].filter(([url]) => !only || only.has(url)).sort((a, b) => (dateIn(b[1]) ?? "").localeCompare(dateIn(a[1]) ?? ""));
    let count = 0;
    for (const [url, label] of ordered) {
      if (attempted.has(url) || count >= limit) continue;
      count++;
      attempted.add(url);
      try {
        const [final, bytes] = await safeFetcher.get(url, DOCUMENT_BYTES, "application/pdf,text/html");
        const pdf = new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
        if ((!pdf || searchUrls.has(url)) && !sameSite(final, website)) continue;
        const html = pdf ? null : parseHtml(new TextDecoder().decode(bytes), final);
        if (html && html.links.filter((link) => DOCUMENT.test(`${link.label} ${link.url}`)).length >= 2) continue;
        const lines = pdf ? await pdfLines(bytes) : html!.lines;
        const fact = meetingFrom(lines, final, label, town, context.today, context.window);
        result.pages_checked.push(final);
        if (fact && !events.some((event) => event.source_url === fact.source_url && event.kind === fact.kind)) events.push(fact);
      } catch (error) { if (retryable(error)) throw error; context.log.warn("council_document_unusable", { url, error: String(error) }); }
    }
  }
  await collectCandidates(context.settings.tavilySearchApiKey ? Math.floor(MAX_DOCUMENTS / 2) : MAX_DOCUMENTS);
  if (!events.length && cachedPage && retry && !archivePage) {
    await context.linkCache.invalidate(context.location.id, task.source_id);
    return collectCouncilDocuments(context, task, website, false);
  }
  // Search only after the official-site path yields nothing. Search results can supply
  // a missing clerk page or a PDF on the official domain; all still go through Fetcher.
  if (!events.length && !archivePage && context.settings.tavilySearchApiKey && !context.readOnly) {
    const searched = await searchCouncilDocuments(context.transport, context.settings.tavilySearchApiKey, website, town, context.today.slice(0, 4), context.log);
    result.web_search = { status: searched.error ? "failed" : "checked", results: searched.hits.length, ...(searched.error ? { error: searched.error } : {}) };
    if (searched.error) result.detail = `Official council documents not found; site-restricted web search failed: ${searched.error}`;
    queue.length = 0;
    const beforeSearch = new Set(candidates.keys());
    for (const hit of searched.hits) {
      searchUrls.add(hit.url);
      if (/\.pdf$/i.test(new URL(hit.url).pathname)) candidates.set(hit.url, hit.title);
      else if (!visited.has(hit.url) && !queue.includes(hit.url)) {
        queue.push(hit.url);
        if (DOCUMENT.test(hit.title)) candidates.set(hit.url, hit.title);
      }
    }
    // A broad homepage crawl may have exhausted its page budget; allow two extra pages
    // specifically for search leads, without re-fetching any page already checked.
    const searchPages = pages.length;
    const extraPages = Math.min(MAX_PAGES + 2, searchPages + 2);
    while (queue.length && pages.length < extraPages) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        const [final, html] = await safeFetcher.getText(url, PAGE_BYTES, "text/html");
        if (!sameSite(final, website)) continue;
        const page = parseHtml(html, final);
        pages.push(page);
        result.pages_checked.push(final);
        if (hasMeetingArchive(html)) {
          try {
            const archive = await wordpressArchive(safeFetcher, final, website, context.today, context.window, DOCUMENT_PAST_DAYS);
            result.pages_checked.push(...archive.endpoints);
            archivePage = final;
            for (const link of archive.links) candidates.set(link.url, /minutes[^<]{0,200}posted[^<]{0,150}approved by council/i.test(html) && link.label.startsWith("Minutes") ? `Approved ${link.label}` : link.label);
          } catch (error) { if (retryable(error)) throw error; result.archive_error = String(error); context.log.warn("council_archive_unavailable", { page: final, error: String(error) }); }
        }
        addCandidates([page]);
      } catch (error) { if (retryable(error)) throw error; context.log.warn("council_search_page_unavailable", { url, error: String(error) }); }
    }
    await collectCandidates(MAX_DOCUMENTS - attempted.size, new Set([...candidates.keys()].filter((url) => !beforeSearch.has(url) || searchUrls.has(url))));
    if (events.length) result.link_discovery = { method: "search", detail: "Site-restricted web search; document verified on the official website" };
  }
  result.event_count = events.length;
  if (!events.length && archivePage) result.detail = "Official council archive found; no parseable agenda or minutes in the current collection window";
  if (events.length) result.feed_url = events[0].source_url;
  if (events.length) { result.status = "ingested"; result.detail = `${events.filter((e) => e.kind === "meeting_preview").length} upcoming council agendas, ${events.filter((e) => e.kind === "meeting_outcome").length} recorded council outcomes from official documents`; }
  if (archivePage || events.length && pages.length) {
    const sourceUrls = new Set(events.map((event) => event.source_url));
    const page = archivePage ? pages.find((item) => item.url === archivePage) : pages.find((item) => item.links.some((link) => sourceUrls.has(link.url)));
    if (page) await context.linkCache.put({ location_id: context.location.id, source_id: task.source_id, kind: "council_documents", url: page.url, page: website, method: result.link_discovery?.method === "search" ? "search" : "rules" });
  } else if (cachedPage) {
    await context.linkCache.invalidate(context.location.id, task.source_id);
    if (retry) return collectCouncilDocuments(context, task, website, false);
  }
  return { result, events };
}
