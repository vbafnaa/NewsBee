import { describe, expect, it, vi } from "vitest";
import { clusterRows, constrainView, fitView, heatCells, locatedRows, MIN_WIDTH, project, transformView } from "../../../lib/usage-map-geometry";
import { loadSampleUsage } from "../../../app/interest-usage/preview/sample-data";
import UsageMapPreview from "../../../app/interest-usage/preview/page";
import type { UsageRow } from "../../analytics/usage";

const size = { width: 800, height: 440 };
const row = (id: string, longitude: number | null, latitude: number | null, reads = 1): UsageRow => ({
  id, name: id, longitude, latitude, reads, subscriptions: reads * 2, interest: reads * 3, onboarded: true,
});
const data = [row("a", -122.3321, 47.6062, 4), row("b", -122.3321, 47.6062, 7), row("c", -122.342, 47.609, 9), row("far", -122.68, 45.52, 12)];

describe("usage-map viewport", () => {
  it("fits all filtered coordinates with useful padding, including one/coincident community and world edges", () => {
    for (const rows of [data, data.slice(0, 1), data.slice(0, 2), [row("west", -180, -90), row("east", 180, 90)]]) {
      const located = locatedRows(rows, "reads"), view = fitView(located, size);
      expect(view.width).toBeGreaterThanOrEqual(.08);
      for (const item of located) {
        const point = project(item.longitude, item.latitude, view, size);
        expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(size.width);
        expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(size.height);
      }
    }
  });
  it("zooms around the pointer and supports reversible drag, touch pinch and keyboard pan math", () => {
    const view = fitView(locatedRows(data, "reads"), size), anchor = { x: 220, y: 180 };
    const zoomed = transformView(view, size, anchor, anchor, 2);
    expect(zoomed.width).toBe(view.width / 2);
    const longitude = view.x + (anchor.x - size.width / 2) * view.width / size.width;
    const latitude = -(view.y + (anchor.y - size.height / 2) * view.width / size.width);
    expect(project(longitude, latitude, zoomed, size).x).toBeCloseTo(anchor.x);
    expect(project(longitude, latitude, zoomed, size).y).toBeCloseTo(anchor.y);
    const next = { x: 280, y: 210 };
    const pinch = transformView(view, size, anchor, next, 2);
    expect(project(longitude, latitude, pinch, size).x).toBeCloseTo(next.x);
    expect(project(longitude, latitude, pinch, size).y).toBeCloseTo(next.y);
    const panned = transformView(view, size, anchor, next);
    const restored = transformView(panned, size, next, anchor);
    expect(restored.x).toBeCloseTo(view.x); expect(restored.y).toBeCloseTo(view.y);
    expect(constrainView({ ...view, width: 0 }, size).width).toBe(MIN_WIDTH);
    const world = constrainView({ x: 10000, y: -10000, width: 100000 }, size);
    expect(world.width).toBe(360); expect(world.x).toBeCloseTo(0); expect(world.y).toBeCloseTo(0);
  });
});

describe("zoom-dependent aggregation", () => {
  it("separates nearby communities when zoomed while keeping coincident communities selectable", () => {
    const located = locatedRows(data, "reads"), initial = fitView(located, size);
    const groups = clusterRows(located, "reads", initial, size);
    expect(groups.find((group) => group.rows.some((item) => item.id === "a"))?.rows).toHaveLength(3);
    const close = { x: -122.335, y: -47.607, width: .02 };
    const zoomed = clusterRows(located, "reads", close, size);
    expect(zoomed.find((group) => group.rows.some((item) => item.id === "a"))?.rows.map((item) => item.id)).toEqual(["a", "b"]);
    expect(zoomed.find((group) => group.rows.some((item) => item.id === "c"))?.rows).toHaveLength(1);
    expect(clusterRows(located.slice(0, 2), "reads", { ...close, width: MIN_WIDTH }, size)[0].count).toBe(11);
    expect(clusterRows([...located].reverse(), "reads", close, size)).toEqual(zoomed);
  });
  it("never loses or duplicates counts across metrics, zooms and desktop/mobile extents", () => {
    for (const metric of ["reads", "subscriptions", "interest"] as const) {
      const located = locatedRows(data, metric), total = located.reduce((sum, item) => sum + item[metric], 0);
      for (const width of [360, 10, .02, MIN_WIDTH]) {
        const view = { x: -122.335, y: -47.607, width };
        expect(heatCells(located, metric, view).cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(total);
        for (const dimensions of [size, { width: 320, height: 320 }]) {
          const clusters = clusterRows(located, metric, view, dimensions);
          expect(clusters.reduce((sum, group) => sum + group.count, 0)).toBe(total);
          expect(clusters.flatMap((group) => group.rows.map((item) => item.id)).sort()).toEqual(data.map((item) => item.id).sort());
          for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
            expect(Math.hypot(clusters[i].x - clusters[j].x, clusters[i].y - clusters[j].y)).toBeGreaterThanOrEqual(48);
          }
        }
      }
    }
  });
  it("excludes missing, invalid and zero-metric geography without changing source counts", () => {
    const rows = [...data, row("missing", null, 47, 5), row("invalid", 200, 47, 6), row("nan", 0, NaN, 7), row("zero", 0, 0, 0)];
    expect(locatedRows(rows, "reads")).toEqual(data);
    expect(rows.reduce((sum, item) => sum + item.reads, 0)).toBe(50);
    expect(heatCells([], "reads", { x: 0, y: 0, width: 360 }).cells).toEqual([]);
    expect(clusterRows([], "reads", fitView([], size), size)).toEqual([]);
  });
  it("recalculates exact sample totals and groups for date and location filters, including empty ranges", async () => {
    const all = await loadSampleUsage(""), day = await loadSampleUsage("from=2026-10-02&to=2026-10-02");
    expect(all.totals).toEqual({ reads: 236, subscriptions: 48, interest: 112 });
    expect(day.totals).toEqual({ reads: 118, subscriptions: 24, interest: 56 });
    const located = locatedRows(day.rows, "reads"), view = fitView(located, size);
    expect(clusterRows(located, "reads", view, size).reduce((sum, group) => sum + group.count, 0)).toBe(113);
    const one = located.filter((item) => item.id === "sample-pike");
    expect(clusterRows(one, "reads", fitView(one, size), size)[0].count).toBe(20);
    expect((await loadSampleUsage("from=2026-10-03")).rows).toEqual([]);
  });
});

it("serves the isolated sample route only in development, never in a production build", () => {
  try {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => UsageMapPreview()).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    vi.stubEnv("NODE_ENV", "development");
    expect(UsageMapPreview().type).toBe("main");
  } finally {
    vi.unstubAllEnvs();
  }
});
