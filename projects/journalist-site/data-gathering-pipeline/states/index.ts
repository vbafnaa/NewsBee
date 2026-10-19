import type { ConfiguredSource } from "@/auth";
import { normalizeWashington } from "./WA";
import type { PipelineItem, RawPipelineItem } from "../types";

const sensitive = /\b(alleg(?:ation|ations|ed|edly)|arrest(?:ed|s)?|charged with|suspect(?:s)?|sexual assault|domestic violence|eviction case|suicide investigation|homicide investigation|disciplinary|medical records?)\b/i;
const privateMatter = /\((tenant|landlord|appellant|petitioner|respondent|claimant|grievant)\)|security deposit case|effective date of benefit|retirement application|disability retirement|personnel matter|workers'? compensation claim/i;

function eligible(item: RawPipelineItem) {
  return Boolean(
    item.title.trim() &&
    item.description.trim() &&
    item.source_url &&
    ["event", "meeting_preview", "meeting_outcome", "state_news", "earthquake", "trending_topic", "social_trend"].includes(item.kind) &&
    !sensitive.test(`${item.title} ${item.description}`) &&
    !privateMatter.test(`${item.title} ${item.description}`),
  );
}

export function normalizeForState(
  source: ConfiguredSource,
  locationId: string,
  locationName: string,
  items: RawPipelineItem[],
): PipelineItem[] {
  const eligibleItems = items.filter(eligible);
  if (source.region?.toUpperCase() === "WA") {
    return normalizeWashington(source, locationId, locationName, eligibleItems);
  }
  if (source.kind === "library") {
    const city = locationName.split(",")[0].trim().toLowerCase();
    return eligibleItems.flatMap((item) => {
      const text = `${item.title} ${item.description} ${item.venue ?? ""}`.toLowerCase();
      if (!city || !text.includes(city)) return [];
      return [{ ...item, local: true }];
    });
  }
  return eligibleItems.map((item) => ({ ...item, local: true }));
}
