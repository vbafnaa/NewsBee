import type { UsageRow } from "@/pipeline/analytics/usage";

export type Metric = "reads" | "subscriptions" | "interest";
export type Size = { width: number; height: number };
export type Position = { x: number; y: number };
export type View = { x: number; y: number; width: number };
export type LocatedRow = UsageRow & { latitude: number; longitude: number };
export const MIN_WIDTH = .005;
export const CLUSTER_DISTANCE = 48;

export function locatedRows(rows: UsageRow[], metric: Metric): LocatedRow[] {
  return rows.filter((row): row is LocatedRow => row.latitude !== null && row.longitude !== null &&
    Number.isFinite(row.latitude) && Number.isFinite(row.longitude) &&
    Math.abs(row.latitude) <= 90 && Math.abs(row.longitude) <= 180 && row[metric] > 0);
}

export function constrainView(view: View, size: Size): View {
  const width = Math.max(MIN_WIDTH, Math.min(Math.max(360, 180 * size.width / size.height), view.width));
  const height = width * size.height / size.width;
  return {
    width,
    x: Math.max(-Math.max(0, 180 - width / 2), Math.min(Math.max(0, 180 - width / 2), view.x)),
    y: Math.max(-Math.max(0, 90 - height / 2), Math.min(Math.max(0, 90 - height / 2), view.y)),
  };
}

export function fitView(rows: LocatedRow[], size: Size): View {
  if (!rows.length) return constrainView({ x: 0, y: 0, width: 360 }, size);
  const west = Math.min(...rows.map((row) => row.longitude)), east = Math.max(...rows.map((row) => row.longitude));
  const south = Math.min(...rows.map((row) => row.latitude)), north = Math.max(...rows.map((row) => row.latitude));
  return constrainView({
    x: (west + east) / 2, y: -(south + north) / 2,
    width: Math.max(.08, (east - west) * 1.35, (north - south) * 1.35 * size.width / size.height),
  }, size);
}

export function project(longitude: number, latitude: number, view: View, size: Size): Position {
  const scale = size.width / view.width;
  return { x: size.width / 2 + (longitude - view.x) * scale, y: size.height / 2 + (-latitude - view.y) * scale };
}

// Keep the geographic point under the gesture's old anchor under its new anchor.
export function transformView(view: View, size: Size, anchor: Position, nextAnchor = anchor, factor = 1): View {
  const width = constrainView({ ...view, width: view.width / factor }, size).width;
  return constrainView({
    width,
    x: view.x + (anchor.x - size.width / 2) * view.width / size.width - (nextAnchor.x - size.width / 2) * width / size.width,
    y: view.y + (anchor.y - size.height / 2) * view.width / size.width - (nextAnchor.y - size.height / 2) * width / size.width,
  }, size);
}

export function heatCells(rows: LocatedRow[], metric: Metric, view: View) {
  const degrees = 2 ** Math.floor(Math.log2(view.width / 16));
  const cells = new Map<string, { longitude: number; latitude: number; count: number }>();
  for (const row of rows) {
    const longitude = Math.floor(row.longitude / degrees) * degrees;
    const latitude = Math.floor(row.latitude / degrees) * degrees;
    const key = `${longitude}:${latitude}`;
    cells.set(key, { longitude, latitude, count: (cells.get(key)?.count ?? 0) + row[metric] });
  }
  return { degrees, cells: [...cells.values()] };
}

export type Cluster = Position & { rows: LocatedRow[]; count: number };
export function clusterRows(rows: LocatedRow[], metric: Metric, view: View, size: Size): Cluster[] {
  const clusters: Cluster[] = [];
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const position = project(row.longitude, row.latitude, view, size);
    clusters.push({ ...position, rows: [row], count: row[metric] });
  }
  // Merge colliding screen-space markers, including coincident points at maximum zoom.
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i], b = clusters[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) >= CLUSTER_DISTANCE) continue;
      const length = a.rows.length + b.rows.length;
      a.x = (a.x * a.rows.length + b.x * b.rows.length) / length;
      a.y = (a.y * a.rows.length + b.y * b.rows.length) / length;
      a.rows.push(...b.rows); a.count += b.count;
      clusters.splice(j, 1);
      i = -1;
      break;
    }
  }
  return clusters;
}
