import { communityPhoto } from "../../../../shared/community-photos";

export function createCommunityCover(locationId: string, api: string): HTMLElement | null {
  const photo = communityPhoto(locationId);
  if (!photo) return null;
  const figure = document.createElement("figure");
  figure.className = "community-cover";
  const image = document.createElement("img");
  image.alt = photo.alt;
  image.width = photo.width;
  image.height = photo.height;
  image.decoding = "async";
  image.fetchPriority = "high";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => { figure.hidden = true; }, { once: true });
  image.src = `${api}/api/community-images/${encodeURIComponent(locationId)}`;
  const caption = document.createElement("figcaption");
  caption.append(document.createTextNode(`Community file photo · ${photo.caption} `));
  const link = (label: string, href: string) => {
    const anchor = document.createElement("a");
    anchor.textContent = label; anchor.href = href;
    anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
    return anchor;
  };
  caption.append(link(photo.credit, photo.source_url), document.createTextNode(" · "), link(photo.license, photo.license_url),
    document.createTextNode(" · Cropped for layout."));
  figure.append(image, caption);
  return figure;
}
