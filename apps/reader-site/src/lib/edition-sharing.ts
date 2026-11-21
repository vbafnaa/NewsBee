export type EditionShareResult = "shared" | "copied" | "cancelled" | "fallback";

export type EditionShareContent = { title: string; url: string };
export type EditionShareCapabilities = {
  share?: (content: EditionShareContent) => Promise<void>;
  copy?: (url: string) => Promise<void>;
};

/** A public edition permalink never inherits the current story, section, day or anchor. */
export function editionShareUrl(origin: string, base: string, locationId: string, editionId: string) {
  const url = new URL(base.replace(/\/+$/, "") || "/", origin);
  url.search = new URLSearchParams({ location: locationId, edition: editionId }).toString();
  url.hash = "";
  return url.href;
}

/** Native cancellation is intentional; other failures may still allow copying the link. */
export async function shareEditionLink(content: EditionShareContent, capabilities: EditionShareCapabilities): Promise<EditionShareResult> {
  if (capabilities.share) {
    try {
      await capabilities.share(content);
      return "shared";
    } catch (error) {
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError") return "cancelled";
    }
  }
  if (capabilities.copy) {
    try {
      await capabilities.copy(content.url);
      return "copied";
    } catch { /* The caller presents a selectable, readonly permalink. */ }
  }
  return "fallback";
}
