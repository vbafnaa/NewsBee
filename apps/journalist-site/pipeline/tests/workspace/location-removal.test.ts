import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import LocationRemoval from "../../../app/locations/[locationId]/location-removal";

it("describes the exact cleanup boundary and requires an explicit confirmation before deletion", () => {
  const html = renderToStaticMarkup(createElement(LocationRemoval, { locationId: "fixture-wa", name: "Fixture town" }));
  expect(html).toContain("Remove location and generated files");
  expect(html).toContain("Fixture town");
  expect(html).toContain("source snapshots, email previews and job logs");
  expect(html).toContain("Keeps shared folders");
  expect(html).toContain("reader submissions, problem reports, subscriptions");
  expect(html).toContain("Untracked files and files in old or unconfigured folders are not purged");
  expect(html).toContain("Cancel active runs");
  expect(html).toContain("Remove this location");
  expect(html).not.toContain('type="submit"');
});

it("identifies incomplete removals as cleanup-only and offers a retry rather than success", () => {
  const html = renderToStaticMarkup(createElement(LocationRemoval, { locationId: "fixture-wa", name: "Fixture town", pending: true }));
  expect(html).toContain('role="alert"');
  expect(html).toContain("Removal is incomplete");
  expect(html).toContain("Retry location removal");
  expect(html).not.toContain("Removed Fixture town");
});

it("mounts removal in Location details and routes the old pipeline action to the same confirmation", async () => {
  const detail = await readFile(new URL("../../../app/locations/[locationId]/location-detail.tsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../../../app/dashboard.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../../../app/locations/[locationId]/location-removal.tsx", import.meta.url), "utf8");
  expect(detail).toContain('view === "profile" && location && <LocationRemoval');
  expect(dashboard).toContain("?tab=settings#remove-location");
  expect(dashboard).not.toContain('window.confirm(`Remove ${row.location_name}?`)');
  expect(panel).toContain("confirmation !== locationId");
  expect(panel.indexOf("await adminApi")).toBeLessThan(panel.indexOf("window.location.assign"));
  expect(panel).toContain('setError(cause instanceof Error ? cause.message : String(cause))');
});
