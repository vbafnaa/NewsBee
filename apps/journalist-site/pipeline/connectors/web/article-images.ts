import { parseHTML } from "linkedom";
import { normalizeStoryImage, safeImageUrl, type StoryImage } from "../../../../../shared/story-image";

export const ARTICLE_PHOTO_POOL_LIMIT = 20;
export const ARTICLE_PHOTO_REVIEW_LIMIT = 4;
type Entry = { image: StoryImage; score: number; order: number };
const text = (value: string | null | undefined, max = 500) => value?.replace(/\s+/g, " ").trim().slice(0, max) || undefined;
const tokens = (value: string) => value.toLocaleLowerCase().normalize("NFKD").split(/[^\p{L}\p{N}]+/u)
  .filter(word => word.length > 2 && !["the", "and", "for", "with", "from", "this", "that", "into", "your", "news", "seattle"].includes(word));
const graphic = /\b(?:logo|icon|avatar|tracking|pixel|sponsor|advertisement|infographic|diagram|map|poster|flyer|illustration)\b/i;

function identity(source: string) {
  const url = new URL(source);
  url.pathname = url.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp)$)/i, "");
  for (const key of ["w", "width", "h", "height", "q", "quality"]) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

/** Collect metadata only. Downloads, permissions and pixel judgments belong to later stages. */
export function rankedArticlePhotos(html: string, pageUrl: string | undefined, supplied: StoryImage[], headline?: string): StoryImage[] {
  const { document } = parseHTML(html.slice(0, 2 * 1024 * 1024));
  const subject = new Set(tokens(headline ?? document.querySelector("h1")?.textContent ?? document.title ?? ""));
  const pool = new Map<string, Entry>();
  let order = 0;
  const add = (value: unknown, editorial = false) => {
    const image = normalizeStoryImage(value, { source_url: pageUrl });
    if (!image || /\.(?:svg|ico)(?:[?#]|$)/i.test(image.image)) return;
    const description = `${image.image_alt ?? ""} ${image.image_caption ?? ""}`;
    const encodedName = new URL(image.image).pathname.split("/").at(-1) ?? "";
    let basename = encodedName;
    try { basename = decodeURIComponent(encodedName); } catch { /* Invalid escapes do not supply image evidence. */ }
    basename = basename.replace(/[_-]/g, " ");
    if (graphic.test(description) || graphic.test(basename)) return;
    const overlap = [...new Set(tokens(description))].filter(word => subject.has(word)).length;
    const score = Math.min(12, overlap * 3) + (image.image_credit ? 4 : 0) + (editorial ? 2 : 0)
      + ((image.image_width ?? 0) >= 1200 ? 2 : 0) + ((image.image_width ?? 0) >= 1800 ? 1 : 0);
    const key = identity(image.image), prior = pool.get(key);
    if (prior && score <= prior.score) return;
    if (!prior && pool.size >= ARTICLE_PHOTO_POOL_LIMIT) {
      const weakest = [...pool.entries()].sort((a, b) => a[1].score - b[1].score || b[1].order - a[1].order)[0];
      if (weakest[1].score >= score) return;
      pool.delete(weakest[0]);
    }
    pool.set(key, { image, score, order: prior?.order ?? order++ });
  };
  supplied.forEach(image => add(image));
  const root = document.querySelector(".entry-content, .post-content, [itemprop=articleBody]") ?? document.querySelector("article, main");
  if (root) for (const img of Array.from(root.querySelectorAll("img")).slice(0, 60)) {
    if (img.closest("aside, nav, header, footer, [role=complementary], .related-posts, .advertisement")) continue;
    const figure = img.closest("figure"), picture = img.closest("picture");
    const width = Number(img.getAttribute("width")) || undefined, height = Number(img.getAttribute("height")) || undefined;
    const variants: Array<{ url: string; width?: number }> = [];
    const srcsets = [img.getAttribute("data-srcset"), img.getAttribute("srcset"), ...Array.from(picture?.querySelectorAll("source") ?? [])
      .filter(source => !source.getAttribute("type") || /^image\/(?:jpeg|png|webp)$/.test(source.getAttribute("type")!))
      .map(source => source.getAttribute("data-srcset") ?? source.getAttribute("srcset"))];
    for (const srcset of srcsets) for (const item of (srcset ?? "").split(",").slice(0, 24)) {
      const match = /^\s*(\S+)\s+(\d+(?:\.\d+)?)(w|x)\s*$/.exec(item);
      const url = match && safeImageUrl(match[1], pageUrl);
      const candidateWidth = match ? Number(match[2]) * (match[3] === "x" ? width ?? 0 : 1) : 0;
      if (url && candidateWidth > 0 && candidateWidth <= 30000) variants.push({ url, width: candidateWidth });
    }
    for (const attr of ["data-original", "data-src", "data-lazy-src", "src"]) {
      const url = safeImageUrl(img.getAttribute(attr), pageUrl);
      if (url) variants.push({ url, ...(attr === "src" ? { width } : {}) });
    }
    const selected = variants.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    if (!selected) continue;
    const caption = text(figure?.querySelector("figcaption")?.textContent ?? img.closest(".featureImage")?.querySelector(".caption")?.textContent);
    const credit = /\bPhotos?(?:graph)?(?: credit)?(?: by|:)\s+([^.;]{1,160})/i.exec(caption ?? "")?.[1]?.trim();
    add({ image: selected.url, image_source_url: pageUrl, image_alt: text(img.getAttribute("alt")), image_caption: caption,
      image_credit: credit, image_width: selected.width, ...(selected.url === safeImageUrl(img.getAttribute("src"), pageUrl) ? { image_height: height } : {}) }, Boolean(figure));
  }
  return [...pool.values()].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, ARTICLE_PHOTO_REVIEW_LIMIT).map(entry => entry.image);
}
