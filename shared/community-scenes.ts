export type ScenePoint = readonly [number, number];
/** Center and radii in the original artwork's normalized coordinates. */
export type SceneRegion = readonly [number, number, number, number];
export type SceneBird = { y: number; duration: number; delay: number; scale: number };
export type SceneLeaf = { x: number; y: number; duration: number; delay: number; drift: number; color: string; scale?: number };
export type SceneBoat = { from: ScenePoint; to: ScenePoint; duration: number; delay: number; scale: number };
export type ScenePose = { at: number; x?: number; y?: number; rotation?: number; scale?: number; opacity?: number };
export type SceneActor = { id: string; outline: string; pivot: ScenePoint; parent?: string; restOpacity?: number };
export type SceneAction = {
  id: string; label: string; region: SceneRegion; duration: number;
  tracks: readonly { actor: string; poses: readonly ScenePose[] }[];
};
export type SceneCast = { backdrop: string; actors: readonly SceneActor[]; actions: readonly SceneAction[] };

export type CommunitySceneConfig = {
  version: 1;
  focalPoint: ScenePoint;
  breeze: readonly SceneRegion[];
  water?: readonly SceneRegion[];
  warmth?: readonly SceneRegion[];
  birds: readonly SceneBird[];
  leaves?: readonly SceneLeaf[];
  steam?: ScenePoint;
  energy?: number;
  interaction?: { kind: "breeze" | "water"; origin: ScenePoint };
  boats?: readonly SceneBoat[];
  cast?: SceneCast;
};

/** Use the same cover geometry for the poster, canvas texture and decorative layers. */
export function sceneGeometry(sourceWidth: number, sourceHeight: number, width: number, height: number,
  focalPoint: ScenePoint = [0.5, 0.5]) {
  if (![sourceWidth, sourceHeight, width, height].every(value => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const imageWidth = sourceWidth * scale, imageHeight = sourceHeight * scale;
  const x = Math.min(1, Math.max(0, focalPoint[0])), y = Math.min(1, Math.max(0, focalPoint[1]));
  const left = (width - imageWidth) * x, top = (height - imageHeight) * y;
  return { imageWidth, imageHeight, left, top,
    crop: [left ? -left / imageWidth : 0, top ? -top / imageHeight : 0, width / imageWidth, height / imageHeight] as const };
}

/** Map a position in the visible frame back to the original painting. */
export function scenePointAt(x: number, y: number, width: number, height: number,
  crop: readonly [number, number, number, number]): ScenePoint | null {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return [crop[0] + Math.min(1, Math.max(0, x / width)) * crop[2],
    crop[1] + Math.min(1, Math.max(0, y / height)) * crop[3]];
}

export function sceneRegionContains(point: ScenePoint, regions: readonly SceneRegion[] = []) {
  return regions.some(([x, y, rx, ry]) => rx > 0 && ry > 0
    && ((point[0] - x) / rx) ** 2 + ((point[1] - y) / ry) ** 2 < 0.8);
}

export function sceneCanPlay(state: {
  ready: boolean; reducedMotion: boolean; visible: boolean; documentHidden: boolean; paused: boolean;
}) {
  return state.ready && !state.reducedMotion && state.visible && !state.documentHidden && !state.paused;
}

/** Clip an artwork-space interaction target to the visible frame. */
export function sceneTargetBounds(region: SceneRegion, geometry: NonNullable<ReturnType<typeof sceneGeometry>>) {
  const [x, y, rx, ry] = region;
  const left = Math.max(0, geometry.left + (x - rx) * geometry.imageWidth);
  const top = Math.max(0, geometry.top + (y - ry) * geometry.imageHeight);
  const right = Math.min(geometry.crop[2] * geometry.imageWidth, geometry.left + (x + rx) * geometry.imageWidth);
  const bottom = Math.min(geometry.crop[3] * geometry.imageHeight, geometry.top + (y + ry) * geometry.imageHeight);
  return right - left >= 24 && bottom - top >= 24 ? { left, top, width: right - left, height: bottom - top } : null;
}
