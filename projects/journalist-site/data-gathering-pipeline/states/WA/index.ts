import config from "../../../../../config/state-sources.json";
import type { ConfiguredSource } from "@/auth";
import type { PipelineItem, RawPipelineItem } from "../../types";

type StateConfiguration = {
  aliases?: string[];
  locations?: Record<string, { point?: number[] }>;
  places?: Record<string, number[]>;
  watchlist?: Array<{ article?: string; place?: string }>;
};

const washington = config.WA as StateConfiguration;

function isPoint(value: number[] | undefined): value is [number, number] {
  return Boolean(value && value.length === 2 && value.every(Number.isFinite));
}

function distanceKm(left: [number, number], right: [number, number]) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const [lat1, lon1] = left.map(radians);
  const [lat2, lon2] = right.map(radians);
  const deltaLat = lat2 - lat1;
  const deltaLon = lon2 - lon1;
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function normalizeWashington(
  source: ConfiguredSource,
  locationId: string,
  locationName: string,
  values: RawPipelineItem[],
): PipelineItem[] {
  const city = locationName.split(",")[0].trim().toLowerCase();
  const candidateOrigin = washington?.locations?.[locationId]?.point ??
    Object.entries(washington?.places ?? {}).find(([name]) => name.toLowerCase() === city)?.[1];
  const origin = isPoint(candidateOrigin) ? candidateOrigin : undefined;
  const knownPlaces = Object.entries(washington?.places ?? {});
  const aliases = (washington?.aliases ?? []).map((alias) => alias.toLowerCase());
  return values.flatMap((item) => {
    const text = `${item.title} ${item.description} ${item.venue ?? ""}`.toLowerCase();
    const mentioned = knownPlaces.filter(([name]) => text.includes(name.toLowerCase()));
    const watch = washington?.watchlist?.find((entry) =>
      entry.article && text.includes(entry.article.replaceAll("_", " ").toLowerCase()));
    const watchPlace = watch?.place?.toLowerCase();
    const isLocal = text.includes(city) || (watchPlace !== undefined && watchPlace === city);
    const nearby = origin !== undefined && mentioned.some(([, point]) =>
      isPoint(point) && distanceKm(origin, point) <= 50);
    const stateMention = aliases.some((alias) => text.includes(alias));
    if (!isLocal && !nearby && !stateMention) return [];
    return [{
      ...item,
      source_id: source.id,
      source_name: source.name,
      section: isLocal ? "In your community" : "Around Washington",
      local: isLocal,
    }];
  });
}
