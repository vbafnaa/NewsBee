/**
 * Jina Reader: a free fallback for pages built by script. It returns the page as markdown, so no
 * model call is needed to read it. It is only ever asked about a page the Fetcher has already
 * read, so robots.txt and the page's usage signals have had their say.
 */
import type { HttpTransport } from "../../core/http";
import { paceService } from "../../trace/gateway";
import { plainText } from "../common";

const TIMEOUT_MS = 10_000;

export type JinaPage = { title: string | null; date: string | null; markdown: string };

export function parseJina(body: string): JinaPage | null {
  const marker = body.indexOf("Markdown Content:");
  const markdown = (marker >= 0 ? body.slice(marker + "Markdown Content:".length) : body).trim();
  if (!markdown) return null;
  const head = marker >= 0 ? body.slice(0, marker) : "";
  const title = /^Title:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? null;
  const published = /^Published Time:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? "";
  const stamp = Date.parse(published);
  return { title, date: Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : null, markdown };
}

export async function jinaRead(transport: HttpTransport, key: string | null | undefined, url: string): Promise<JinaPage | null> {
  try {
    await paceService("jina", Boolean(key));
    const response = await transport({ url: `https://r.jina.ai/${url}`, headers: { Accept: "text/plain", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, timeoutMs: TIMEOUT_MS, maxBytes: 2 * 1024 * 1024 });
    return response.status < 400 ? parseJina(new TextDecoder().decode(response.body)) : null;
  } catch { return null; }
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Markdown as simple HTML, so the same page checks read it: paragraphs and links. */
export function jinaHtml(page: JinaPage) {
  const lines = page.markdown.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) =>
    `<p>${escape(line).replace(/\[([^\]]*)\]\((https:\/\/[^\s)]+)\)/g, (_, text: string, link: string) => `<a href="${link}">${text}</a>`)}</p>`);
  return `<html><head><title>${escape(plainText(page.title ?? "", 200) ?? "")}</title></head><body><main>${lines.join("")}</main></body></html>`;
}
