/**
 * Court and prosecution news from official sources only: U.S. Department of Justice press
 * releases for the state's U.S. Attorney's Offices (justice.gov API, newest first), plus any
 * county prosecutor or state attorney general feeds that editors add as source links.
 * No police call logs, mugshots or scanner traffic.
 *
 * Kept: charges (reported as allegations), convictions and guilty pleas, and sentences,
 * when the release names the location (or its city/county, as the wider tier). Dropped:
 * releases that are not about a case (events, appointments, outreach) and anything outside
 * the window. Cases involving children or sex offences are kept; the writing floor keeps
 * minors and victims unnamed.
 */
import { addDays, httpsLink, plainText } from "../common";
import { dayCached } from "../day-cache";
import { localityFor, quickEvidence, type Locality } from "../locality";
import { mentions } from "../community";
import { sourceResult, type CollectedEvent, type CollectedSource, type Connector, type ConnectorContext, type SourceResult, type SourceTask } from "../types";
import { parseNewsFeed, publishedText, sha256 } from "../wider/adapters";
import { fetchBytes, fetchJson, locationRegion, runCollector, skip, SourceUnavailable } from "../parents/shared";
import { rangesFor } from "../../core/time";
import { US_STATES } from "../../../../../shared/geography";
import * as ranking from "../../ranking/exploration";
import { itemCap } from "../../core/run-options";

export const DOJ_API = "https://www.justice.gov/api/v1/press_releases.json";
export const DOJ_PAGE_SIZE = 50;
export const MAX_PAGES = 20;
export const LOOKBACK_DAYS = 14;
export const MAX_ITEMS = 6;
const ACCEPT_FEED = "application/rss+xml, application/atom+xml, application/xml, text/xml";

/** Cases where the writing floor withholds names (minors, sexual and domestic violence victims). */
export const EXCLUDED = /\b(child(?:ren)?|minors?|juveniles?|teen(?:age(?:r|rs)?)?|students?|sex(?:ual|ually)?|sex offender|porn\w*|csam|rape\w*|enticement|exploit\w*|molest\w*|incest|obscen\w*|sextortion|domestic violence|stalk\w*)\b/i;
const SENTENCED = /\b(sentenced|sentencing of|to (?:federal )?prison|sent to prison|years? in (?:federal )?prison|months? in (?:federal )?prison)\b/i;
const CONVICTED = /\b(convicted|found guilty|jury verdict|pleads? guilty|pleaded guilty|admits?|admitted)\b/i;
const CHARGED = /\b(charged|charges|indicted|indictment|arrested|complaint (?:filed|unsealed)|accused)\b/i;
export type Stage = "sentenced" | "convicted" | "charged";
export const STAGE_ORDER: Record<Stage, number> = { sentenced: 3, convicted: 2, charged: 1 };

/** The case stage a title announces; the title is checked first, then the teaser. */
export function caseStage(title: string, teaser = ""): Stage | null {
  for (const text of [title, teaser]) {
    if (SENTENCED.test(text) && !/\bfaces? up to\b/i.test(text)) return "sentenced";
    if (CONVICTED.test(text)) return "convicted";
    if (CHARGED.test(text)) return "charged";
  }
  return null;
}

export type Release = { id: string; title: string; day: string; url: string; teaser: string; body: string; offices: string[] };

export function dojPageUrl(page: number) {
  // justice.gov robots.txt allows /api/ only with a page parameter.
  return `${DOJ_API}?page=${page}&pagesize=${DOJ_PAGE_SIZE}&sort=date&direction=DESC`;
}
export function parseDojPage(value: unknown): Release[] {
  const results = (value as { results?: Array<Record<string, unknown>> })?.results;
  if (!Array.isArray(results)) throw new SourceUnavailable("failed", "Justice Department API did not return results");
  return results.flatMap((row) => {
    const seconds = Number(row.date);
    const url = httpsLink(typeof row.url === "string" ? row.url : null);
    if (!Number.isFinite(seconds) || !url || typeof row.title !== "string") return [];
    const offices = Array.isArray(row.component) ? row.component.map((c) => String((c as { name?: unknown }).name ?? "")).filter(Boolean) : [];
    return [{
      id: String(row.uuid ?? url), title: plainText(row.title, 300)?.replace(/\.$/, "") ?? row.title.trim(),
      day: new Date(seconds * 1000).toISOString().slice(0, 10), url,
      teaser: plainText(row.teaser, 600) ?? "", body: plainText(row.body, 2500) ?? "", offices,
    }];
  });
}

/** Releases from the state's U.S. Attorney's Offices ("USAO - Washington, Western"). */
export function stateOffice(release: Release, stateName: string) {
  const prefix = `USAO - ${stateName}`.toLowerCase();
  return release.offices.find((office) => {
    const name = office.toLowerCase();
    return name === prefix || name.startsWith(`${prefix},`);
  }) ?? null;
}
export function officeName(office: string) {
  const [, rest] = office.split(" - ");
  const [state, district] = (rest ?? office).split(",").map((part) => part.trim());
  return district ? `U.S. Attorney's Office for the ${district} District of ${state}` : `U.S. Attorney's Office for the District of ${state}`;
}

/** Newest-first DOJ pages back to `since`, each page cached for the day across locations. */
async function dojReleases(context: ConnectorContext, since: string, record: SourceResult): Promise<Release[]> {
  const releases: Release[] = [];
  for (let page = 0; page < itemCap(MAX_PAGES); page += 1) {
    const url = dojPageUrl(page);
    const rows = await dayCached(context.db, `doj-releases-v1:${context.today}:${page}`, async () => parseDojPage(await fetchJson(context, url)));
    if (page === 0) record.feed_url = url;
    releases.push(...rows);
    if (!rows.length || rows.at(-1)!.day < since) return releases;
  }
  skip(record, "page_limit");
  return releases;
}


export const justiceConnector: Connector = {
  type: "justice",
  meta: {
    name: "Courts & prosecutions",
    formats: "U.S. Department of Justice press releases for the state's U.S. Attorney's Offices, and editor-added county prosecutor or attorney general feeds",
    manual: true,
    coverage: { group: "wider", label: "official court and prosecution announcements" },
    storyKinds: ["court_case"],
  },
  window: { back: { since: "last_edition", maxDays: LOOKBACK_DAYS } },
  rank: ranking.justice,
  sources(location, settings) {
    if (!settings.widerSources || !US_STATES[location.state]) return [];
    return [
      { source_id: "justice:doj", name: "U.S. Attorney's Office announcements", type: "justice" },
    ];
  },
  collect(task, context) { return runCollector(task, context, (record) => collectJustice(task, context, record)); },
};

type Candidate = { id: string; title: string; day: string; url: string; text: string; office: string; teaser: string };

async function collectJustice(task: SourceTask, context: ConnectorContext, record: SourceResult): Promise<CollectedEvent[]> {
  const since = rangesFor(context, justiceConnector.window).back?.[0] ?? addDays(context.today, -LOOKBACK_DAYS);
  const stateName = US_STATES[context.location.state];
  const candidates: Candidate[] = [];
  const manualFeed = typeof task.params?.manual_feed === "string" ? task.params.manual_feed : null;
  if (task.source_id === "justice:doj") {
    record.feed_kind = "doj_api"; record.website = "https://www.justice.gov/news";
    const releases = await dojReleases(context, since, record);
    for (const release of releases) {
      const office = stateOffice(release, stateName);
      if (!office) continue;
      candidates.push({ id: release.id, title: release.title, day: release.day, url: release.url, teaser: release.teaser, text: `${release.teaser} ${release.body}`, office: officeName(office) });
    }
    record.pages_checked.push(`${releases.length} national releases read; ${candidates.length} from ${stateName}'s U.S. Attorney's Offices`);
  } else {
    const feeds = manualFeed ? [{ name: task.name, feed: manualFeed, office: task.name }] : [];
    if (!feeds.length) throw new SourceUnavailable("no_feed", "Add a county prosecutor or attorney general feed as a source link");
    record.feed_kind = "rss";
    for (const feed of feeds) {
      const items = parseNewsFeed(await fetchBytes(context, feed.feed, ACCEPT_FEED));
      record.pages_checked.push(feed.feed);
      for (const item of items) candidates.push({ id: item.id, title: item.title, day: item.published_day, url: item.link, teaser: item.summary ?? "", text: item.summary ?? "", office: feed.office ?? feed.name });
    }
  }
  const region = await locationRegion(context);
  const locality = await localityFor(context, { geocodes: 6, articles: 0 });
  const wider = [locality.town, region.county, context.location.community?.parent_name].filter((name): name is string => Boolean(name));
  const events: CollectedEvent[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (seen.has(item.url)) { skip(record, "duplicate"); continue; }
    seen.add(item.url);
    if (item.day < since || item.day > context.today) { skip(record, "outside_window"); continue; }
    const stage = caseStage(item.title, item.teaser);
    if (!stage) { skip(record, "not_a_case"); continue; }
    const tier = courtTier(locality, wider, item);
    if (!tier) { skip(record, "not_near_town"); continue; }
    events.push(caseFacts(item, stage, tier.tier, tier.section, tier.evidence));
  }
  events.sort((a, b) => Number(a.tier !== "local") - Number(b.tier !== "local") || Number((b.signals as Record<string, number>).stage) - Number((a.signals as Record<string, number>).stage) || String(b.event_date).localeCompare(String(a.event_date)));
  const kept = events.slice(0, itemCap(MAX_ITEMS));
  skip(record, "item_limit", events.length - kept.length);
  record.detail = `${candidates.length} announcements since ${since}; ${events.length} name ${locality.town} or its area (${kept.length} kept)`;
  return kept;
}

function courtTier(locality: Locality, wider: string[], item: Candidate) {
  const texts = [item.title, item.text];
  const local = quickEvidence(locality, texts);
  if (local) return { tier: "local" as const, section: `Courts in ${locality.location.community?.name ?? locality.town}`, evidence: local };
  const area = wider.find((name) => texts.some((text) => mentions(text, name)));
  return area ? { tier: "region" as const, section: `Courts around ${area}`, evidence: { method: "town_mention" as const, matches: [area] } } : null;
}

export function caseFacts(item: Candidate, stage: Stage, tier: "local" | "region", section: string, evidence: unknown): CollectedEvent {
  const summary = item.teaser || (item.text.match(/[^.!?]+[.!?]/g) ?? []).slice(0, 3).join(" ").trim();
  let description = `The ${item.office} announced: ${summary}`.trim();
  if (stage === "charged") description += " A charge is an allegation; a person charged is presumed innocent unless and until proven guilty in court.";
  return {
    source_event_id: sha256(item.id).slice(0, 16), title: item.title, event_date: item.day, schedule_text: publishedText(item.day),
    venue: item.office, room: null, source_url: item.url, description: plainText(description, 1500) ?? description,
    kind: "court_case", tier, section, stage, locality: evidence,
    signals: { stage: STAGE_ORDER[stage], office: item.office },
  } as CollectedEvent;
}
