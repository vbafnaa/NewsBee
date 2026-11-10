import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import robotsParser from "robots-parser";
import { publicHttpsGet } from "../../../shared/image-http";
import { safeImageUrl } from "../../../shared/story-image";
import { AI_AGENTS, USER_AGENT, blockedPlatform } from "../pipeline/connectors/fetcher";
import { advertisedFeeds } from "../pipeline/connectors/feeds";
import { pageRights, rightsAction } from "../pipeline/connectors/web/page";
import { Parser } from "htmlparser2";

// This gathers evidence only. A successful response or robots Allow never approves reuse.
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.indexOf(name) < 0 ? fallback : args[args.indexOf(name) + 1] || fallback;
const root = path.resolve(process.cwd(), "../..");
const output = path.resolve(option("--output", path.join(root, ".local/source-research/source-access-audit")));
const input = path.resolve(option("--input", path.join(root, ".local/source-research/photo-audit-sheet.csv")));
const allCommunities = ["beacon-hill", "wedgwood", "ballard", "moses-lake"];
await mkdir(path.join(output, "evidence"), { recursive: true });
const rows = parse(await readFile(input, "utf8"), { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const robots = new Map<string, Promise<any>>();
const fetched = new Map<string, Promise<any>>();
const hostQueue = new Map<string, Promise<unknown>>();
const last = new Map<string, number>();

function communities(row: Record<string, string>) {
  const value = `${row.Community} ${row["Source name"]}`.toLowerCase();
  if (/beacon hill|cleveland|franklin|wiaa/.test(value)) return ["beacon-hill"];
  if (/wedgwood|ne seattle|roosevelt|nathan hale|seattle schools athletics|wa death records/.test(value)) return ["wedgwood"];
  if (/moses lake/.test(value)) return ["moses-lake"];
  if (/ballard/.test(value)) return ["ballard"];
  return allCommunities;
}

async function request(url: string, interval = 750) {
  const host = new URL(url).host;
  const previous = hostQueue.get(host) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const wait = (last.get(host) ?? 0) + interval - Date.now();
    if (wait > 0) await delay(wait);
    last.set(host, Date.now());
    return publicHttpsGet({ url, timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html, application/rss+xml, application/atom+xml, application/json, text/calendar, text/plain, */*;q=0.1" } });
  });
  hostQueue.set(host, operation);
  return operation;
}

async function robotsFor(raw: string) {
  const origin = new URL(raw).origin;
  if (robots.has(origin)) return robots.get(origin)!;
  const promise = (async () => {
    const url = `${origin}/robots.txt`;
    try {
      let next = url;
      let response: Awaited<ReturnType<typeof request>> | undefined;
      for (let hop = 0; hop <= 3; hop++) {
        response = await request(next);
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
          const target = safeImageUrl(response.headers.location, next);
          if (!target) throw new Error("Unsafe robots redirect");
          next = target;
        } else break;
      }
      if (!response) throw new Error("No robots response");
      const body = text(response.body);
      const file = `robots-${hash(origin)}.txt`;
      await writeFile(path.join(output, "evidence", file), body);
      const usable = response.status >= 200 && response.status < 300 && !/^\s*</.test(body);
      const missing = response.status === 404 || response.status === 410;
      const rules = usable ? robotsParser(url, body) : null;
      const crawlDelay = rules ? rules.getCrawlDelay("Newsbee") ?? rules.getCrawlDelay("*") ?? 0 : 0;
      return { url, status: response.status, usable, missing, crawlDelay, file, rules,
        error: usable || missing ? null : "robots policy unavailable or not plain text" };
    } catch (error) { return { url, status: null, usable: false, missing: false, crawlDelay: 0, error: String(error), rules: null }; }
  })();
  robots.set(origin, promise);
  return promise;
}

function robotVerdict(policy: any, url: string) {
  if (!policy.usable && !policy.missing) return { allowed: false, reason: policy.error };
  if (policy.crawlDelay > 30) return { allowed: false, reason: `crawl-delay ${policy.crawlDelay}s exceeds Newsbee limit` };
  for (const agent of [USER_AGENT, "Newsbee", ...AI_AGENTS]) {
    if (policy.rules?.isAllowed(url, agent) === false) return { allowed: false, reason: `robots disallows ${agent}` };
  }
  return { allowed: true, reason: policy.missing ? "No robots file; this is not permission" : "Robots permits this path; terms still require review" };
}

async function getPage(raw: string): Promise<any> {
  if (fetched.has(raw)) return fetched.get(raw)!;
  const operation = (async () => {
    let url = safeImageUrl(raw);
    if (!url || blockedPlatform(url)) return { url: raw, allowed: false, reason: "Platform excluded by Newsbee crawling policy" };
    const hops = [];
    for (let hop = 0; hop <= 3; hop++) {
      const policy = await robotsFor(url);
      const verdict = robotVerdict(policy, url);
      const { rules, ...summary } = policy;
      hops.push({ url, robots: summary, ...verdict });
      if (!verdict.allowed) return { url, allowed: false, reason: verdict.reason, hops };
      const response = await request(url, Math.max(750, policy.crawlDelay * 1000));
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        url = safeImageUrl(response.headers.location, url);
        if (!url || blockedPlatform(url)) return { allowed: false, reason: "Unsafe or excluded redirect", hops };
        continue;
      }
      const body = text(response.body);
      const type = response.headers["content-type"] ?? "";
      const flags = [...pageRights(response.headers, type.includes("html") ? body : "")];
      const file = `page-${hash(raw)}.txt`;
      await writeFile(path.join(output, "evidence", file), body);
      return { url, status: response.status, allowed: true, type, flags, rights_action: rightsAction(new Set(flags)), file, hops, body };
    }
    return { allowed: false, reason: "Too many redirects", hops };
  })().catch((error) => ({ url: raw, allowed: false, reason: String(error) }));
  fetched.set(raw, operation);
  return operation;
}

function links(html: string, base: string) {
  const out: Array<{ url: string; label: string }> = [];
  let href: string | null = null, label = "";
  const parser = new Parser({ onopentag(name, attrs) { if (name === "a") { href = safeImageUrl(attrs.href, base); label = ""; } },
    ontext(value) { if (href) label += value; }, onclosetag(name) { if (name === "a" && href) { out.push({ url: href, label: label.trim() }); href = null; } } }, { decodeEntities: true });
  parser.write(html); parser.end();
  return out;
}

const results: any[] = [];
let index = 0;
async function worker() {
  while (index < rows.length) {
    const i = index++, row = rows[i];
    const url = row["Where (Link)"]?.trim();
    const base = { source_number: i + 1, name: row["Source name"], category: row.Category, communities: communities(row),
      scope: row.Community, url, proposed_method: row["How we get it"], sheet_conditions: row["Reuse / publishing conditions"],
      sheet_status: row.Status, evidence_url: row["Evidence / documentation"], checked_at: new Date().toISOString() };
    let result: any;
    try {
      const page = await getPage(url);
      const { body, ...pageEvidence } = page;
      const candidates = body && page.type?.includes("html") ? links(body, page.url) : [];
      const termLinks = [...new Map(candidates.filter((link) => /terms|copyright|legal|reuse|republish|permissions|data policy/i.test(`${link.label} ${link.url}`))
        .filter((link) => !/privacy|cookie|accessibility/i.test(link.label)).map((link) => [link.url, link])).values()].slice(0, 3);
      const terms = [];
      for (const link of termLinks.slice(0, 2)) {
        const term = await getPage(link.url);
        const sentences = (term.body ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
        const automation = [...sentences.matchAll(/.{0,130}(?:scrap(?:e|ing)|automat(?:ed|ic)|robots?|data mining|republi(?:sh|cation)|Creative Commons|redistribut).{0,220}/gi)].slice(0, 12).map((m) => m[0]);
        const { body: _body, ...evidence } = term;
        terms.push({ ...link, evidence, automation });
      }
      const feeds = body && page.type?.includes("html") ? advertisedFeeds(body, page.url).slice(0, 3) : [];
      const calendarLinks = candidates.filter((link) => /ical|\.ics\b|rss|atom/i.test(`${link.label} ${link.url}`)).slice(0, 4);
      result = { ...base, page: pageEvidence, term_links: termLinks, terms, discovered_feeds: feeds, discovered_calendars: calendarLinks,
        decision: !page.allowed || page.rights_action === "skip" ? "blocked" : page.status >= 400 ? "unavailable" : "needs_review" };
    } catch (error) { result = { ...base, decision: "unavailable", error: String(error) }; }
    results.push(result);
    await writeFile(path.join(output, "audit.json"), JSON.stringify({ spreadsheet: "13V3WG3vsXFpn_pwgqW2h__b2d2v8dBsWAbT-xbFdHFk", gid: "2144765667", checked_on: "2026-11-01", total: rows.length,
      sources: [...results].sort((a, b) => a.source_number - b.source_number) }, null, 2));
    if (results.length % 10 === 0 || results.length === rows.length) console.log(`Audited ${results.length}/${rows.length}: ${result.name} (${result.decision})`);
  }
}
await Promise.all(Array.from({ length: 6 }, () => worker()));
// Finish with a serialized snapshot after all concurrent checkpoint writes have settled.
await writeFile(path.join(output, "audit.json"), JSON.stringify({
  spreadsheet: "13V3WG3vsXFpn_pwgqW2h__b2d2v8dBsWAbT-xbFdHFk", gid: "2144765667", checked_on: new Date().toISOString().slice(0, 10),
  total: rows.length, sources: results.sort((a, b) => a.source_number - b.source_number),
}, null, 2));
console.log(`Evidence saved to ${output}`);
