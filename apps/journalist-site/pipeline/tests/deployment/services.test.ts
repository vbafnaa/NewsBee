import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const config = JSON.parse(readFileSync(new URL("../../../../../vercel.json", import.meta.url), "utf8"));

function serviceFor(path: string) {
  return config.rewrites.find((rewrite: { source: string }) =>
    new RegExp(`^${rewrite.source.replace("/:path*", "/(.*)")}$`).test(path),
  )?.destination.service;
}

it("deploys only the supported apps and retains the private pipeline queue trigger", () => {
  expect(Object.keys(config.services)).toEqual(["journalist-site", "reader-site"]);
  expect(config.services["journalist-site"].root).toBe("apps/journalist-site");
  expect(config.services["reader-site"].root).toBe("apps/reader-site");
  expect(config.services["journalist-site"].functions["app/api/pipeline/queue/route.ts"])
    .toEqual({
      experimentalTriggers: [{ type: "queue/v2beta", topic: "journalist-pipeline-jobs" }],
    });
  expect(config).not.toHaveProperty("functions");
  expect(config).not.toHaveProperty("framework");
});

it.each([
  "/reader",
  "/reader/",
  "/reader/api/editions",
  "/reader/api/editions/seattle-wa",
  "/reader/api/locations/search",
  "/reader/api/locations/seattle-wa/interest",
  "/reader/_astro/index.js",
])("routes %s to the reader", (path) => {
  expect(serviceFor(path)).toBe("reader-site");
});

it("selects base-relative Astro output routes while preserving the original request path", () => {
  expect(config.rewrites.slice(0, 2)).toEqual([
    { source: "/reader", destination: { service: "reader-site", path: "/" } },
    { source: "/reader/:path*", destination: { service: "reader-site", path: "/:path*" } },
  ]);
});

it.each([
  "/",
  "/login",
  "/health",
  "/output-channel",
  "/api/auth/callback/google",
  "/api/admin/locations",
  "/api/pipeline/advance",
  "/api/pipeline/tick",
  "/_next/static/app.js",
  "/reader-other",
])("keeps %s in the journalist service", (path) => {
  expect(serviceFor(path)).toBe("journalist-site");
});
