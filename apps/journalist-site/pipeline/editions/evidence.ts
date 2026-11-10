import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { DiscoveryBlockedError, Fetcher } from "../connectors/fetcher";
import { httpsLink } from "../connectors/common";
import { publicSourceTransport } from "../connectors/public-http";
import { mainText, pageRights, rightsAction, supportingLinks } from "../connectors/web/page";
import type { HttpTransport } from "../core/http";
import { relaxedContentAllowed } from "../core/run-options";
import type { Logger } from "../core/log";
import { itemTexts, mergeDetails, saveText, type Details, type FactSupport } from "./details";
import type { Story } from "./stories";

export const EVIDENCE_POLICY = "evidence_v1";
export const EVIDENCE_LIMITS = { pages: 20, perHost: 4, sourcesPerStory: 2, milliseconds: 45_000, requestMs: 5_000, textChars: 12_000, packetChars: 6_000 };
export const EVIDENCE_CACHE_MS = 24 * 3600_000;
export type EvidenceSource = {
  url: string; final_url: string | null; status: "fetched" | "cached" | "blocked" | "failed" | "thin" | "budget" | "unsupported";
  reason: string | null; content_hash: string | null; fetched_at: string | null; passages: string[]; truncated?: boolean;
};
export type EvidencePacket = {
  policy: typeof EVIDENCE_POLICY; sources: EvidenceSource[]; text_quality: "substantial" | "thin" | "none";
  extraction: "not_requested" | "complete" | "model_unavailable" | "budget_exhausted" | "failed";
  extraction_error: string | null; missing: string[];
  facts?: Array<FactSupport & { source_urls: string[] }>;
};

const USEFUL = /\b(deadline|apply|register|registration|eligible|eligibility|cost|fee|free|comment|attend|effective|approved|vote|closure|closed|starts?|ends?|until|residents?|students?|families)\b|\$\s*\d/i;
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");
class EvidenceBudgetError extends Error {}

/** Keep the opening and useful later passages, in source order, rather than a blind prefix. */
export function selectPassages(text: string, limit = EVIDENCE_LIMITS.packetChars): string[] {
  const paragraphs = text.split(/\n+/).map((part) => part.trim()).filter(Boolean)
    .flatMap((part) => Array.from(sentences.segment(part), ({ segment }) => segment))
    .map((part) => part.trim()).filter((part) => part.length > 0 && part.length <= limit);
  const scored = paragraphs.map((part, index) => ({ part, index, priority: (index === 0 ? 5 : 0) + (USEFUL.test(part) ? 3 : 0) + (/\d/.test(part) ? 1 : 0) }));
  const chosen: typeof scored = [];
  let used = 0;
  for (const candidate of [...scored].sort((a, b) => b.priority - a.priority || a.index - b.index)) {
    if (chosen.some((item) => item.part === candidate.part) || used + candidate.part.length + 1 > limit) continue;
    chosen.push(candidate); used += candidate.part.length + 1;
  }
  return chosen.sort((a, b) => a.index - b.index).map((item) => item.part);
}

export function evidenceText(packet: EvidencePacket | undefined, limit = EVIDENCE_LIMITS.packetChars) {
  return selectPassages((packet?.sources ?? []).flatMap((source) => source.passages).join("\n"), limit).join("\n");
}

export function missingDetails(details: Details): string[] {
  return [
    !details.what.length && "what happened", !details.when && "when", !details.places.length && "where",
    !details.next_step && "resident next step",
  ].filter((field): field is string => Boolean(field));
}

export function supportedFacts(details: Details, packet: EvidencePacket) {
  const normal = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  return (details.support ?? []).map((fact) => ({
    ...fact, source_urls: packet.sources.filter((source) => normal(source.passages.join(" ")).includes(normal(fact.quote))).map((source) => source.final_url ?? source.url),
  }));
}

export function evidenceFor(story: Story) {
  const packet = story.facts.evidence as EvidencePacket | undefined;
  return packet?.policy === EVIDENCE_POLICY ? packet : undefined;
}

export function rankingDescription(story: Story) {
  const passages = selectPassages(evidenceText(evidenceFor(story)), 600);
  const evidence = passages.sort((a, b) => Number(USEFUL.test(b)) - Number(USEFUL.test(a))).join("\n");
  return evidence || story.description;
}

export class EvidenceReader {
  private used = 0;
  private readonly hosts = new Map<string, number>();
  private readonly reads = new Map<string, Promise<{ source: EvidenceSource; links: string[] }>>();
  private readonly deadline: number;
  private readonly fetcher: Fetcher;

  constructor(private readonly db: Db, transport: HttpTransport, private readonly log: Logger, pace = true) {
    this.deadline = Date.now() + EVIDENCE_LIMITS.milliseconds;
    const safeTransport = publicSourceTransport(transport, EVIDENCE_LIMITS.requestMs);
    this.fetcher = new Fetcher((request) => {
      const url = new URL(request.url), host = url.hostname;
      if (url.pathname !== "/robots.txt") {
        if (Date.now() >= this.deadline || (this.hosts.get(host) ?? 0) >= EVIDENCE_LIMITS.perHost) throw new EvidenceBudgetError("Section time or host budget reached");
        this.hosts.set(host, (this.hosts.get(host) ?? 0) + 1);
      }
      return safeTransport(request);
    }, undefined, pace);
  }

  private async read(url: string) {
    const source: EvidenceSource = { url, final_url: null, status: "unsupported", reason: null, content_hash: null, fetched_at: null, passages: [] };
    const result = { source, links: [] as string[] };
    if (!httpsLink(url) || /\.(docx?|xlsx?|zip)$/i.test(new URL(url).pathname)) {
      source.reason = "Only permitted HTTPS HTML and text PDFs are supported"; return result;
    }
    const cached = await itemTexts(this.db).findOne({ _id: url, reuse_allowed: true, ...(!relaxedContentAllowed() ? { relaxed: { $ne: true } } : {}), fetched_at: { $gte: new Date(Date.now() - EVIDENCE_CACHE_MS) } });
    if (cached) {
      source.status = "cached"; source.final_url = cached.canonical_url ?? url;
      source.content_hash = contentHash(cached.text); source.fetched_at = cached.fetched_at.toISOString();
      source.passages = selectPassages(cached.text);
      source.truncated = cached.text.length >= EVIDENCE_LIMITS.textChars;
      result.links = cached.supporting_urls ?? [];
      return result;
    }
    const host = new URL(url).hostname;
    if (this.used >= EVIDENCE_LIMITS.pages || (this.hosts.get(host) ?? 0) >= EVIDENCE_LIMITS.perHost || Date.now() >= this.deadline) {
      source.status = "budget"; source.reason = "Section page, host or time budget reached"; return result;
    }
    this.used++;
    let cacheText: string | null = null;
    try {
      const response = await this.fetcher.getResponse(url, 4 * 1024 * 1024, "text/html, application/xhtml+xml, application/pdf;q=0.9");
      source.final_url = response.url;
      const pdf = /application\/pdf/i.test(response.headers["content-type"] ?? "") || new TextDecoder().decode(response.body.subarray(0, 5)) === "%PDF-";
      const html = pdf ? "" : new TextDecoder().decode(response.body);
      if (rightsAction(pageRights(response.headers, html)) !== "ok") {
        source.status = "blocked"; source.reason = "Page reuse restrictions or paywall"; return result;
      }
      if (!pdf && !/text\/html|application\/xhtml\+xml/i.test(response.headers["content-type"] ?? "")) {
        source.status = "unsupported"; source.reason = "Response is not HTML or a text PDF"; return result;
      }
      const text = pdf ? (await (await import("../connectors/meetings/documents")).pdfLines(response.body)).join("\n") : mainText(html, EVIDENCE_LIMITS.textChars);
      source.fetched_at = new Date().toISOString();
      const bounded = text?.slice(0, EVIDENCE_LIMITS.textChars) ?? "";
      source.truncated = Boolean(text && text.length >= EVIDENCE_LIMITS.textChars);
      source.passages = selectPassages(bounded);
      source.content_hash = bounded ? contentHash(bounded) : null;
      source.status = source.passages.join(" ").length >= 200 ? "fetched" : "thin";
      if (source.status === "thin") source.reason = "Little usable article text; may need editorial input";
      result.links = supportingLinks(html, response.url);
      cacheText = bounded || null;
    } catch (error) {
      source.status = error instanceof EvidenceBudgetError ? "budget" : error instanceof DiscoveryBlockedError ? "blocked" : "failed";
      source.reason = error instanceof Error ? error.message : String(error);
      this.log.warn("evidence_page_unavailable", { url, status: source.status, error: source.reason });
      return result;
    }
    if (cacheText) await saveText(this.db, url, cacheText, { canonical_url: source.final_url!, reuse_allowed: true, supporting_urls: result.links });
    return result;
  }

  private page(url: string) {
    let read = this.reads.get(url);
    if (!read) { read = this.read(url); this.reads.set(url, read); }
    return read;
  }

  async enrich(stories: Story[]) {
    const followups: Array<{ story: Story; url: string }> = [];
    for (const story of stories) {
      const packet: EvidencePacket = { policy: EVIDENCE_POLICY, sources: [], text_quality: "none", extraction: "not_requested", extraction_error: null, missing: missingDetails(mergeDetails(story.facts.details as Details | undefined)) };
      story.facts.evidence = packet;
      if (story.facts.link_only || story.facts.no_page_fetch) {
        packet.sources.push({ url: story.first.source_url, final_url: null, status: "blocked", reason: "Source is link-only; do not enrich or author from its body", content_hash: null, fetched_at: null, passages: [] });
        continue;
      }
      const url = story.first.source_url;
      if (!url) continue;
      const first = await this.page(url);
      packet.sources.push(first.source);
      const other = story.occurrences.map((item) => item.source_url).find((link) => link && link !== url);
      const next = other ?? first.links[0];
      if (next) followups.push({ story, url: next });
    }
    // All candidates get their first source considered before any story gets a second.
    for (const { story, url } of followups) {
      if (evidenceFor(story)!.sources.length < EVIDENCE_LIMITS.sourcesPerStory) evidenceFor(story)!.sources.push((await this.page(url)).source);
    }
    for (const story of stories) {
      const packet = evidenceFor(story)!;
      const length = evidenceText(packet).length;
      packet.text_quality = length >= 800 ? "substantial" : length > 0 ? "thin" : "none";
    }
    this.log.info("Section evidence gathered", { stories: stories.length, pages_fetched: this.used, substantial: stories.filter((story) => evidenceFor(story)?.text_quality === "substantial").length });
  }
}
