/**
 * Title checks for collected items, shared by the web reader and the assembler. No server imports.
 *
 *   site name   a title that is only the site's or the source's name ("Columbia Basin Herald") or a
 *               navigation heading ("Latest stories", "Home") is a page of the site, not a story.
 *   word count  a news publisher's headline needs at least MIN_TITLE_WORDS words, not counting a
 *               trailing "| Site name". Local organisations' own posts, events, meetings, obituaries,
 *               sports results and record digests are exempt: "Community garden meeting", "Storytime",
 *               "Jane Doe" and "Boys Basketball" are real titles there.
 *
 * Both are left out with the reason, so the run's item list shows what was rejected and why.
 */
export const MIN_TITLE_WORDS = 4;

/** Kinds whose titles are a news publisher's headline, so a very short one isn't a story. */
export const HEADLINE_KINDS = new Set(["news_report", "state_news", "trending_topic", "social_trend", "court_case"]);

/** Headings of listing and navigation pages, compared after the site name is cut off. */
const NAVIGATION = new Set(["home", "homepage", "home page", "welcome", "news", "latest news", "latest stories", "top stories", "all stories", "local news", "events", "calendar", "obituaries", "sports", "archive", "archives", "search", "page not found", "not found"]);

export function normaliseName(value: string | null | undefined) {
  return String(value ?? "").toLowerCase().replace(/&amp;|&/g, " and ").replace(/[‘’'`]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/^the /, "").trim();
}

export function wordCount(title: string) {
  return title.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** The title without a trailing " | Site name" or " - Site name". */
function withoutSuffix(title: string) {
  return title.replace(/\s+[|–—-]\s+[^|–—-]{2,80}$/, "").trim();
}

/** Why a title is only the site's name or a navigation heading, or null. */
export function siteNameProblem(title: string, names: Array<string | null | undefined>) {
  const plain = normaliseName(title);
  if (!plain) return "no title";
  const known = names.map(normaliseName).filter((name) => name.length >= 3);
  if (known.includes(plain)) return `title is only the site's name ("${title.trim()}")`;
  const head = normaliseName(withoutSuffix(title));
  if (NAVIGATION.has(plain) || NAVIGATION.has(head)) return `title is a navigation page, not a story ("${title.trim()}")`;
  return null;
}

/** The title without a trailing "| Site name", only when that part is one of `names`. */
function withoutSiteName(title: string, names: Array<string | null | undefined>) {
  const suffix = /\s+[|–—-]\s+([^|–—-]{2,80})$/.exec(title);
  const known = names.map(normaliseName).filter((name) => name.length >= 3);
  return suffix && known.includes(normaliseName(suffix[1])) ? title.slice(0, suffix.index).trim() : title;
}

/** Why a title fails the title rules, or null when it passes. */
export function titleProblem(title: string, kind: string | null | undefined, names: Array<string | null | undefined>) {
  const named = siteNameProblem(title, names);
  if (named) return named;
  if (HEADLINE_KINDS.has(String(kind ?? "")) && wordCount(withoutSiteName(title, names)) < MIN_TITLE_WORDS) return `title under ${MIN_TITLE_WORDS} words ("${title.trim()}")`;
  return null;
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12" };

/**
 * A publication date written in a story's address: /2026/11/08/, /2026/nov/08/ or /2026-11-08-slug.
 * Only a full year, month and day counts, and only when the date is real.
 */
export function urlDate(url: string | null | undefined): string | null {
  let path: string;
  try { path = new URL(String(url)).pathname.toLowerCase(); } catch { return null; }
  const match = /(?:^|\/)(20\d{2})[/-](0?[1-9]|1[0-2]|jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*[/-](0?[1-9]|[12]\d|3[01])(?=[/-]|$)/.exec(path);
  if (!match) return null;
  const month = MONTHS[match[2]] ?? match[2].padStart(2, "0");
  const day = `${match[1]}-${month}-${match[3].padStart(2, "0")}`;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}
