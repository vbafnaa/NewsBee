import { MIN_STORY_IMAGE_HEIGHT, MIN_STORY_IMAGE_WIDTH, normalizeStoryImage, type StoryImage } from "../../../../shared/story-image";
import { allowsContextPhoto, photoCredit } from "../../../../shared/photo-presentation";
import { photoStoryMismatch } from "../../../../shared/photo-story-match";

type MediaStory = Partial<StoryImage> & {
  headline: string;
  kind?: string;
  section?: string | null;
  section_id?: string | null;
  source_name?: string;
  source_url?: string | null;
  blurb?: string | null;
  when_where?: string | null;
};

/** Missing or failed photos leave a text-only story, without decorative placeholders. */
export function createStoryMedia(story: MediaStory, deliveryUrl: string | null, lead = false) {
  const media = normalizeStoryImage(story, story);
  if (!media?.image_source_url || !deliveryUrl) return null;
  if (!allowsContextPhoto(story.kind, media.image_role)) return null;
  if (photoStoryMismatch(story, media)) return null;
  const figure = document.createElement("figure");
  figure.className = "story-media";
  const frame = document.createElement("div");
  frame.className = "story-image-frame";
  const caption = document.createElement("figcaption");
  figure.append(frame, caption);

  const image = document.createElement("img");
  image.alt = media.image_alt ?? "";
  image.width = media.image_width ?? 1200;
  image.height = media.image_height ?? 800;
  image.loading = lead ? "eager" : "lazy";
  image.decoding = "async";
  image.fetchPriority = lead ? "high" : "low";
  image.referrerPolicy = "no-referrer";
  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    figure.remove();
  };
  image.addEventListener("load", () => {
    if (settled) return;
    // Small icons and tracking pixels are unsuitable for editorial photography.
    if (image.naturalWidth < MIN_STORY_IMAGE_WIDTH || image.naturalHeight < MIN_STORY_IMAGE_HEIGHT) { fail(); return; }
    settled = true;
    figure.classList.remove("is-loading");
    figure.classList.add("has-photo");
    const credit = document.createElement("a");
    credit.textContent = photoCredit(media, story.source_name);
    credit.href = media.image_source_url!;
    credit.target = "_blank";
    credit.rel = "noopener noreferrer";
    if (media.image_role || media.image_license) {
      const license = document.createElement(media.image_license_url ? "a" : "span");
      license.textContent = media.image_license!;
      if (license instanceof HTMLAnchorElement) {
        license.href = media.image_license_url!;
        license.target = "_blank";
        license.rel = "noopener noreferrer";
      }
      const details = document.createElement("details");
      details.className = "photo-details";
      const toggle = document.createElement("summary");
      toggle.textContent = "ⓘ";
      toggle.setAttribute("aria-label", "Photo details and license");
      toggle.title = "Photo details and license";
      const body = document.createElement("div");
      body.className = "photo-details-body";
      const source = credit.cloneNode(true) as HTMLAnchorElement;
      source.textContent = `Photo: ${media.image_credit || story.source_name || "original source"}`;
      body.append(source, document.createTextNode(" · "), license,
        document.createTextNode(` · Taken ${media.image_date}. Cropped for layout. ${media.image_role === "stock"
          ? "Stock image; not the event, venue or participants." : media.image_role === "area"
            ? "Area context; not the permitted work or its progress." : media.image_role === "venue" ? "Location context; not the event." : ""}`));
      details.append(toggle, body);
      const label = document.createElement("span");
      label.className = "photo-credit";
      if (media.image_role === "stock") label.textContent = "Stock Photo";
      else label.append(credit);
      caption.replaceChildren(label, details);
    } else caption.replaceChildren(credit);
  }, { once: true });
  image.addEventListener("error", fail, { once: true });
  figure.classList.add("is-loading");
  frame.append(image);
  image.src = deliveryUrl;
  return figure;
}
