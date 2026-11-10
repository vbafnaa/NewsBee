export const NEIGHBORHOOD_ART = [
  { id: "wedgwood", location_ids: ["osm-r13915552-wa", "wedgwood-seattle-wa", "wedgwood-wa"], name: "Wedgwood",
    asset: "wedgwood-welcome", intro: "Leafy streets, cozy neighborhood shops, and familiar faces. A little closer to home.",
    alt: "AI watercolor portrait of Wedgwood: mature leafy trees, modest houses, gardens, small neighborhood shops and adult neighbors greeting one another.",
    palette: "Forest green, maple gold and warm terracotta" },
  { id: "moses-lake", location_ids: ["moses-lake-wa"], name: "Moses Lake",
    asset: "moses-lake-welcome", intro: "Lake days, open skies, and the warmth of a small-town hello. Your community, a little closer.",
    alt: "AI watercolor portrait of Moses Lake: open blue water, golden reeds, a lakeside path, low dry hills and neighbors enjoying the shore.",
    palette: "Lake blue, sage and sun-warmed gold" },
] as const;
export type NeighborhoodArt = typeof NEIGHBORHOOD_ART[number];

export function neighborhoodArt(locationId: string): NeighborhoodArt | null {
  return NEIGHBORHOOD_ART.find(profile => (profile.location_ids as readonly string[]).includes(locationId)) ?? null;
}

export function neighborhoodArtAsset(profile: NeighborhoodArt, base = "", small = false) {
  return `${base.replace(/\/$/, "")}/illustrations/${profile.asset}-v1${small ? "-960" : ""}.webp`;
}
