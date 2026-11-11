import type { CommunitySceneConfig } from "./community-scenes";
import { MOSES_LAKE_CAST, WEDGWOOD_CAST } from "./community-casts";

export type NeighborhoodArt = {
  id: string; location_ids: readonly string[]; name: string; asset: string;
  intro: string; alt: string; palette: string; motion?: CommunitySceneConfig;
  presentation?: { sky: string; glow: string; focalPoint: readonly [number, number] };
};

export const NEIGHBORHOOD_ART = [
  { id: "wedgwood", location_ids: ["osm-r13915552-wa", "wedgwood-seattle-wa", "wedgwood-wa"], name: "Wedgwood",
    asset: "wedgwood-welcome", intro: "Leafy streets, cozy neighborhood shops, and familiar faces. A little closer to home.",
    alt: "AI watercolor portrait of Wedgwood: mature leafy trees, modest houses, gardens, small neighborhood shops and adult neighbors greeting one another.",
    palette: "Forest green, maple gold and warm terracotta",
    presentation: { sky: "#e1ead8", glow: "#f4e6c9", focalPoint: [0.57, 0.5] },
    motion: {
      version: 1, focalPoint: [0.64, 0.5], energy: 1.25,
      cast: WEDGWOOD_CAST,
      interaction: { kind: "breeze", origin: [0.58, 0.34] },
      breeze: [[0.105, 0.34, 0.16, 0.13], [0.32, 0.38, 0.12, 0.12], [0.58, 0.32, 0.15, 0.12], [0.87, 0.34, 0.13, 0.12]],
      warmth: [[0.141, 0.567, 0.022, 0.033], [0.719, 0.595, 0.038, 0.05]],
      birds: [{ y: 0.18, duration: 32, delay: -11, scale: 0.9 }, { y: 0.21, duration: 37, delay: -22, scale: 0.65 }],
      leaves: [
        { x: 0.15, y: 0.33, duration: 11, delay: -3, drift: 85, color: "#b88a42", scale: 1.4 },
        { x: 0.32, y: 0.36, duration: 13, delay: -9, drift: 65, color: "#9b9f51", scale: 1.1 },
        { x: 0.57, y: 0.31, duration: 12, delay: -8, drift: -65, color: "#b7a250", scale: 1.5 },
        { x: 0.64, y: 0.35, duration: 14, delay: -2, drift: 72, color: "#b88a42", scale: 1.2 },
        { x: 0.88, y: 0.35, duration: 15, delay: -6, drift: 58, color: "#a29248", scale: 1.4 },
      ],
      steam: [0.714, 0.635],
    } },
  { id: "moses-lake", location_ids: ["moses-lake-wa"], name: "Moses Lake",
    asset: "moses-lake-welcome", intro: "Lake days, open skies, and the warmth of a small-town hello. Your community, a little closer.",
    alt: "AI watercolor portrait of Moses Lake: open blue water, golden reeds, a lakeside path, low dry hills and neighbors enjoying the shore.",
    palette: "Lake blue, sage and sun-warmed gold",
    presentation: { sky: "#d9edf1", glow: "#f5e4c6", focalPoint: [0.44, 0.5] },
    motion: {
      version: 1, focalPoint: [0.27, 0.5], energy: 1.2,
      cast: MOSES_LAKE_CAST,
      interaction: { kind: "water", origin: [0.5, 0.6] },
      breeze: [[0.15, 0.33, 0.145, 0.12], [0.485, 0.678, 0.06, 0.065], [0.82, 0.675, 0.17, 0.07]],
      water: [[0.62, 0.58, 0.37, 0.045], [0.76, 0.632, 0.23, 0.055]],
      birds: [{ y: 0.31, duration: 35, delay: -8, scale: 0.85 }, { y: 0.29, duration: 41, delay: -24, scale: 0.65 }],
      boats: [{ from: [0.36, 0.585], to: [0.86, 0.595], duration: 52, delay: -14, scale: 1.3 }],
    } },
] as const satisfies readonly NeighborhoodArt[];

export function neighborhoodArt(locationId: string): NeighborhoodArt | null {
  return NEIGHBORHOOD_ART.find(profile => (profile.location_ids as readonly string[]).includes(locationId)) ?? null;
}

export function neighborhoodArtAsset(profile: NeighborhoodArt, base = "", small = false) {
  return `${base.replace(/\/$/, "")}/illustrations/${profile.asset}-v1${small ? "-960" : ""}.webp`;
}
