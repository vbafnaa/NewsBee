/** Publisher image metadata, shared by collection, publication and the browser. */
export type StoryImage = {
  /** Kept as a string for editions published before image metadata existed. */
  image: string;
  image_credit?: string;
  image_source_url?: string;
  image_alt?: string;
  image_width?: number;
  image_height?: number;
  image_catalog_id?: string;
  image_catalog_revision?: string;
  image_role?: "venue" | "area" | "stock";
  /** Actual venue/street depicted, kept separate from the longer audit caption. */
  image_place?: string;
  image_subject?: string;
  image_caption?: string;
  image_date?: string;
  image_license?: string;
  image_license_url?: string;
  image_asset_id?: string;
};
export type StoryImageMetadata = Omit<StoryImage, "image">;
export const MIN_STORY_IMAGE_WIDTH = 240;
export const MIN_STORY_IMAGE_HEIGHT = 120;

/** Syntactic public-URL check. Server fetchers must also check DNS and every redirect. */
export function safeImageUrl(value: unknown, baseUrl?: string): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || /[\u0020\\]/.test(value.trim()) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;
  try {
    const url = baseUrl ? new URL(value.trim(), baseUrl) : new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.includes(".") && !host.startsWith("[")) return null;
    if (/(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|invalid)$/.test(host)) return null;
    if (/^[\d.]+$/.test(host)) {
      const [a, b, c] = host.split(".").map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) return null;
    }
    // Only global-unicast IPv6 literals; excludes mapped IPv4, loopback, link/unique-local.
    if (host.startsWith("[") && (!/^\[[23][0-9a-f]{3}:/.test(host) || /^\[2001:db8:/.test(host))) return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function label(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || undefined : undefined;
}
function dimension(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 && number <= 30000 ? number : undefined;
}

/** Keep each image and its provenance together when duplicate reports are merged. */
export function normalizeStoryImage(value: unknown, fallback: { source_url?: string | null; source_name?: string } = {}): StoryImage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const source = safeImageUrl(raw.image_source_url) ?? safeImageUrl(fallback.source_url);
  const image = safeImageUrl(raw.image, source ?? undefined);
  if (!image) return null;
  const credit = label(raw.image_credit, 240) ?? label(fallback.source_name, 240);
  const alt = label(raw.image_alt, 500);
  const width = dimension(raw.image_width), height = dimension(raw.image_height);
  const role = raw.image_role === "venue" || raw.image_role === "area" || raw.image_role === "stock" ? raw.image_role : null;
  const place = label(raw.image_place, 120);
  const subject = label(raw.image_subject, 160);
  const asset = typeof raw.image_asset_id === "string" && /^[a-f0-9]{64}$/.test(raw.image_asset_id) ? raw.image_asset_id : undefined;
  const catalogId = typeof raw.image_catalog_id === "string" && /^[a-f0-9]{64}$/.test(raw.image_catalog_id) ? raw.image_catalog_id : undefined;
  const catalogRevision = typeof raw.image_catalog_revision === "string" && /^[a-f0-9]{64}$/.test(raw.image_catalog_revision) ? raw.image_catalog_revision : undefined;
  const caption = label(raw.image_caption, 500), date = label(raw.image_date, 10);
  const license = label(raw.image_license, 100), licenseUrl = safeImageUrl(raw.image_license_url);
  const privateGrant = Boolean(catalogId && catalogRevision && license === "Used with permission");
  if (role && (!caption || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !license || !licenseUrl && !privateGrant)) return null;
  // Skip known thumbnails/pixels here so extraction can try the next publisher candidate.
  if ((width !== undefined && width < MIN_STORY_IMAGE_WIDTH) || (height !== undefined && height < MIN_STORY_IMAGE_HEIGHT)) return null;
  return { image, ...(asset ? { image_asset_id: asset } : {}), ...(catalogId && catalogRevision ? { image_catalog_id: catalogId, image_catalog_revision: catalogRevision } : {}),
    ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { image_date: date } : {}),
    ...(license && (licenseUrl || license === "Used with permission") ? { image_license: license, ...(licenseUrl ? { image_license_url: licenseUrl } : {}) } : {}),
    ...(source ? { image_source_url: source } : {}), ...(credit ? { image_credit: credit } : {}),
    ...(alt ? { image_alt: alt } : {}), ...(place ? { image_place: place } : {}), ...(subject ? { image_subject: subject } : {}), ...(caption ? { image_caption: caption } : {}), ...(width ? { image_width: width } : {}), ...(height ? { image_height: height } : {}),
    ...(role ? { image_role: role, image_caption: caption, image_date: date, image_license: license } : {}) };
}
