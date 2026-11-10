import { decodeHTML } from "entities";
import type { HttpTransport } from "../core/http";
import { publicHttpsGet } from "../../../../shared/image-http";
import { normalizeStoryImage, safeImageUrl, type StoryImage } from "../../../../shared/story-image";

export type PhotoCandidate = { title: string; accepted: boolean; reason: string; image?: StoryImage; original_image?: string; original_width?: number; original_height?: number;
  catalog?: { id: string; revision: string } };
type Field = { value?: unknown };
export type CommonsPage = { title?: string; imageinfo?: Array<{ url?: string; thumburl?: string; descriptionurl?: string;
  width?: number; height?: number; thumbwidth?: number; thumbheight?: number; mime?: string; extmetadata?: Record<string, Field> }> };
const clean = (value: unknown) => typeof value === "string" ? decodeHTML(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
const words = (value: string) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const MAX_PHOTO_AGE_DAYS = 365;

export function captureDate(value: unknown): string | null {
  const text = clean(value).replace(/^Taken on\s+/i, "");
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[ T]|$)/.exec(text)?.[1];
  const named = /^\d{1,2} [A-Za-z]+ \d{4}(?:,|$)/.exec(text)?.[0].replace(/,$/, "");
  if (!iso && !named) return null;
  const time = Date.parse(iso ? iso + "T00:00:00Z" : named + " UTC");
  if (!Number.isFinite(time)) return null;
  const date = new Date(time).toISOString().slice(0, 10);
  return iso && date !== iso ? null : date;
}

function reuseLicense(name: string, url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url.replace(/^http:/, "https:")); } catch { return null; }
  if (parsed.hostname !== "creativecommons.org" || parsed.search || parsed.hash) return null;
  const license = /^\/licenses\/(by|by-sa)\/(2\.0|2\.5|3\.0|4\.0)\/?$/.exec(parsed.pathname);
  if (license && name.toUpperCase() === `CC ${license[1].toUpperCase()} ${license[2]}`) return parsed.href;
  if (/^CC0(?: 1\.0)?$/i.test(name) && /^\/publicdomain\/zero\/1\.0\/(?:deed(?:\.[a-z-]+)?)?\/?$/.test(parsed.pathname)) return parsed.href;
  return null;
}

/** Conservative venue identity matching: both the named venue and its city must be explicit. */
export function reviewCommonsPhoto(page: CommonsPage, venue: string, city: string, today = new Date()): PhotoCandidate {
  const title = clean(page.title), info = page.imageinfo?.[0], meta = info?.extmetadata ?? {};
  const reject = (reason: string): PhotoCandidate => ({ title, accepted: false, reason });
  if (!info || !/^image\/(jpeg|png|webp)$/.test(info.mime ?? "")) return reject("not_a_supported_photograph");
  const venueKey = words(venue), cityKey = words(city);
  if (venueKey.split(" ").length < 2 || !cityKey) return reject("venue_identity_too_vague");
  const description = clean(meta.ImageDescription?.value);
  const identity = words(`${title.replace(/^File:/, "")} ${description}`);
  const contains = (phrase: string) => (` ${identity} `).includes(` ${phrase} `);
  if (!contains(venueKey) || !contains(cityKey)) return reject("venue_or_city_mismatch");
  if (/\b(portrait|headshot|logo|poster|diagram|map|statue|bird|shrew|flower|demolished|former|historic photograph)\b/i.test(`${title} ${description}`)
    || /AI.generated|synthetic|illustration|rendering/i.test(clean(meta.Categories?.value))) return reject("unsuitable_venue_subject");
  return reviewLicensedPhoto(page, { role: "venue", place: venue, alt: `View of ${venue}, ${city}`,
    caption: `${venue}, ${city}. Location context for the upcoming event.` }, today);
}

/** A permit may use a streetscape only when the named street and city match. */
export function reviewAreaPhoto(page: CommonsPage, street: string, city: string, today = new Date()): PhotoCandidate {
  const title = clean(page.title), info = page.imageinfo?.[0], meta = info?.extmetadata ?? {};
  const text = words(`${title} ${clean(meta.ImageDescription?.value)}`);
  const canonical = (s: string) => words(s).replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave").replace(/\broad\b/g, "rd")
    .replace(/\bnorthwest\b/g, "nw").replace(/\bnortheast\b/g, "ne").replace(/\bsouthwest\b/g, "sw").replace(/\bsoutheast\b/g, "se")
    .replace(/\bnorth\b/g, "n").replace(/\bsouth\b/g, "s").replace(/\beast\b/g, "e").replace(/\bwest\b/g, "w");
  const identity = ` ${canonical(text)} `;
  const name = canonical(street), suffix = /^(.*) (n|s|e|w|ne|nw|se|sw)$/.exec(name);
  const prefix = /^(n|s|e|w|ne|nw|se|sw) (.*)$/.exec(name);
  const names = [name, ...(suffix ? [`${suffix[2]} ${suffix[1]}`] : []), ...(prefix ? [`${prefix[2]} ${prefix[1]}`] : [])];
  const matches = names.some(name => identity.includes(` ${name} `));
  if (!matches || !identity.includes(` ${words(city)} `)) return { title, accepted: false, reason: "street_or_city_mismatch" };
  if (/\b(interior|bedroom|listing|for sale|floor plan|demolished|historic photograph)\b/i.test(text)) return { title, accepted: false, reason: "unsuitable_area_subject" };
  return reviewLicensedPhoto(page, { role: "area", place: street, alt: `Streetscape on ${street}, ${city}`,
    caption: `${street}, ${city}. Area context, not the permitted work.` }, today);
}

/** License, provenance and age checks shared by source, context and stock photos. */
export function reviewLicensedPhoto(page: CommonsPage, context: { role: "venue" | "area" | "stock" | "source"; place?: string; subject?: string; alt: string; caption: string }, today = new Date()): PhotoCandidate {
  const title = clean(page.title), info = page.imageinfo?.[0], meta = info?.extmetadata ?? {};
  const reject = (reason: string): PhotoCandidate => ({ title, accepted: false, reason });
  if (!info || !/^image\/(jpeg|png|webp)$/.test(info.mime ?? "")) return reject("not_a_supported_photograph");
  const description = `${title} ${clean(meta.ImageDescription?.value)}`;
  if (/\b(logo|poster|diagram|map|statue)\b/i.test(description)
    || !(context.subject && context.role === "source") && /\b(portrait|headshot)\b/i.test(description)
    || /AI.generated|synthetic|illustration|rendering/i.test(clean(meta.Categories?.value))) return reject("unsuitable_photo_subject");
  if (meta.Restrictions?.value && (typeof meta.Restrictions.value !== "string" || clean(meta.Restrictions.value))
    || /permission required|non.commercial|no.derivatives/i.test(clean(meta.UsageTerms?.value))) return reject("reuse_restrictions");
  const date = captureDate(meta.DateTimeOriginal?.value);
  if (!date) return reject("capture_date_unknown");
  const age = today.getTime() - Date.parse(date + "T00:00:00Z");
  if (age < 0 || age > MAX_PHOTO_AGE_DAYS * 86400000) return reject("capture_date_not_recent");
  const license = clean(meta.LicenseShortName?.value);
  const licenseUrl = reuseLicense(license, clean(meta.LicenseUrl?.value));
  if (!licenseUrl) return reject("license_not_approved");
  const credit = clean(meta.Artist?.value);
  const imageUrl = safeImageUrl(info.thumburl ?? info.url);
  const sourceUrl = safeImageUrl(info.descriptionurl);
  if (!credit || !imageUrl || !sourceUrl || new URL(imageUrl).hostname !== "thumb.wikimedia.org" && new URL(imageUrl).hostname !== "upload.wikimedia.org"
    || new URL(sourceUrl).hostname !== "commons.wikimedia.org" || !new URL(sourceUrl).pathname.startsWith("/wiki/File:")) return reject("missing_or_invalid_provenance");
  const image = normalizeStoryImage({ image: imageUrl, image_source_url: sourceUrl, image_credit: credit,
    image_width: info.thumbwidth ?? info.width, image_height: info.thumbheight ?? info.height,
    image_alt: context.alt, ...(context.role === "source" ? {} : { image_role: context.role }), image_place: context.place, image_subject: context.subject, image_caption: context.caption,
    image_date: date, image_license: license, image_license_url: licenseUrl });
  return image ? { title, accepted: true, reason: `recent_licensed_${context.role === "area" ? "street" : context.role}_match`, image,
    original_image: safeImageUrl(info.url) ?? undefined, original_width: info.width, original_height: info.height } : reject("image_too_small");
}

/** One bounded official API request, no article scraping, login or model calls. */
export async function discoverVenuePhotos(venue: string, city: string, today = new Date(), transport: HttpTransport = publicHttpsGet): Promise<PhotoCandidate[]> {
  const venueQuery = words(venue), cityQuery = words(city);
  if (venueQuery.split(" ").length < 2 || !cityQuery) return [];
  return (await searchCommonsPhotos(`"${venueQuery.slice(0, 160)}" "${cityQuery.slice(0, 80)}" filetype:bitmap`, transport))
    .map((page) => reviewCommonsPhoto(page, venue, city, today));
}

export async function discoverAreaPhotos(street: string, city: string, today = new Date(), transport: HttpTransport = publicHttpsGet): Promise<PhotoCandidate[]> {
  return (await searchCommonsPhotos(`"${words(street).slice(0, 160)}" "${words(city).slice(0, 80)}" filetype:bitmap -intitle:DPLA -intitle:MOHAI`, transport))
    .map(page => reviewAreaPhoto(page, street, city, today));
}

export async function searchCommonsPhotos(search: string, transport: HttpTransport = publicHttpsGet): Promise<CommonsPage[]> {
  const query = new URLSearchParams({ action: "query", format: "json", generator: "search", gsrnamespace: "6", gsrlimit: "12",
    gsrsearch: search.slice(0, 300), gsrsort: "create_timestamp_desc",
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "2560", iiextmetadatalanguage: "en" });
  const response = await transport({ url: "https://commons.wikimedia.org/w/api.php?" + query, timeoutMs: 8000, maxBytes: 1024 * 1024,
    headers: { Accept: "application/json", "User-Agent": "Newsbee/1.0 (community-news venue photo review)" } });
  if (response.status !== 200) throw new Error(`Venue image API returned HTTP ${response.status}`);
  const data = JSON.parse(new TextDecoder().decode(response.body)) as { error?: unknown; query?: { pages?: Record<string, CommonsPage> } };
  if (data.error) throw new Error("Venue image API returned an error");
  return Object.values(data.query?.pages ?? {}).slice(0, 12);
}

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const CATEGORY_PAGE_SIZE = 12;
export const MAX_CATEGORY_PHOTOS = 24;

type CommonsResponse = { batchcomplete?: unknown; error?: unknown; continue?: { gcmcontinue?: string }; query?: { pages?: Record<string, CommonsPage> } };

async function queryPhotos(parameters: Record<string, string>, transport: HttpTransport): Promise<CommonsResponse> {
  const query = new URLSearchParams({ action: "query", format: "json", prop: "imageinfo", iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "2560", iiextmetadatalanguage: "en", maxlag: "5", ...parameters });
  const response = await transport({ url: `${COMMONS_API}?${query}`, timeoutMs: 8000, maxBytes: 1024 * 1024,
    headers: { Accept: "application/json", "User-Agent": "Newsbee/1.0 (community photo discovery)" } });
  if (response.status !== 200) throw new Error(`Commons photo API returned HTTP ${response.status}`);
  const data = JSON.parse(new TextDecoder().decode(response.body)) as CommonsResponse;
  if (!data || typeof data !== "object" || data.error || !data.query && !("batchcomplete" in data))
    throw new Error("Commons photo API returned an invalid response");
  return data;
}

/** Read files directly in one configured category; never traverse unrelated subcategories. */
export async function categoryCommonsPhotos(category: string, transport: HttpTransport = publicHttpsGet): Promise<CommonsPage[]> {
  if (!/^Category:[^|\u0000-\u001f]{1,240}$/.test(category)) throw new Error("Invalid Commons category");
  const photos = new Map<string, CommonsPage>();
  let continuation: string | undefined;
  for (let page = 0; page < 2; page += 1) {
    const data = await queryPhotos({ generator: "categorymembers", gcmtitle: category, gcmnamespace: "6", gcmtype: "file",
      gcmlimit: String(CATEGORY_PAGE_SIZE), ...(continuation ? { gcmcontinue: continuation } : {}) }, transport);
    for (const photo of Object.values(data.query?.pages ?? {})) {
      if (photo.title?.startsWith("File:") && !photos.has(photo.title)) photos.set(photo.title, photo);
      if (photos.size === MAX_CATEGORY_PHOTOS) break;
    }
    const next = data.continue?.gcmcontinue;
    if (photos.size === MAX_CATEGORY_PHOTOS || !next || next === continuation || next.length > 1024) break;
    continuation = next;
  }
  return [...photos.values()];
}

export async function namedCommonsPhotos(files: string[], transport: HttpTransport = publicHttpsGet): Promise<CommonsPage[]> {
  if (!files.length || files.length > 12 || files.some(file => !/^File:[^|\u0000-\u001f]{1,240}$/.test(file)))
    throw new Error("Invalid Commons file list");
  const data = await queryPhotos({ titles: [...new Set(files)].join("|") }, transport);
  return Object.values(data.query?.pages ?? {}).filter(photo => photo.title?.startsWith("File:")).slice(0, 12);
}
