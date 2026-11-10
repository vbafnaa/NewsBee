import type { StoryImage } from "./story-image";

/** The reading surface carries a credit; the audit belongs in progressive disclosure. */
export function photoCredit(photo: Partial<StoryImage>, sourceName?: string) {
  if (photo.image_role === "stock") return "Stock Photo";
  const author = photo.image_credit?.trim() || sourceName?.trim();
  const place = photo.image_place?.trim()
    || photo.image_caption?.match(/^(?:View (?:from|of) )?([^;,.]+)(?:[;,]|,? Location context)/i)?.[1]?.trim();
  return `${author ? `Photo: ${author}` : "Photo"}${photo.image_role && place ? `, ${place}` : ""}`;
}

/** Never infer a permit's street from a general neighborhood photograph. */
export function allowsContextPhoto(kind: string | undefined, role: StoryImage["image_role"]) {
  if (!role) return true;
  if (role === "stock") return kind === "event";
  if (role === "area") return kind === "development" || kind === "building_permit";
  return kind === "event" || kind === "meeting_preview";
}
