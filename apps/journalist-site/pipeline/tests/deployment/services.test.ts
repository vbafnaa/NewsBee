import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const config = JSON.parse(readFileSync(new URL("../../../../../vercel.json", import.meta.url), "utf8"));

it.each(["reader-data.ts", "newsletter.ts", "community-intake-storage.ts"])(
  "resolves MongoDB for shared %s when only journalist dependencies are installed",
  (source) => {
    const journalistRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const readerRoot = path.resolve(journalistRoot, "../reader-site");
    const canonical = (value: string) => {
      const absolute = path.resolve(value);
      return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
    };
    const readerDependencies = canonical(path.join(readerRoot, "node_modules"));
    const hidden = (value: string) => {
      const absolute = canonical(value);
      return absolute === readerDependencies || absolute.startsWith(`${readerDependencies}${path.sep}`);
    };
    // Model Vercel's independent service install without modifying either local dependency tree.
    const host = {
      ...ts.sys,
      fileExists: (value: string) => !hidden(value) && ts.sys.fileExists(value),
      directoryExists: (value: string) => !hidden(value) && ts.sys.directoryExists(value),
      readFile: (value: string) => hidden(value) ? undefined : ts.sys.readFile(value),
    };
    const project = ts.readConfigFile(path.join(journalistRoot, "tsconfig.json"), host.readFile);
    expect(project.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(project.config, host, journalistRoot);
    expect(parsed.errors).toEqual([]);
    const containingFile = path.join(readerRoot, "src/lib", source);
    const resolved = ts.resolveModuleName("mongodb", containingFile, parsed.options, host).resolvedModule;
    expect(resolved).toBeDefined();
    expect(canonical(resolved!.resolvedFileName)).toBe(canonical(path.join(journalistRoot, "node_modules/mongodb/mongodb.d.ts")));
    // Ensure this simulation catches the deployment failure without the service-local mapping.
    expect(ts.resolveModuleName("mongodb", containingFile, { ...parsed.options, paths: undefined }, host).resolvedModule).toBeUndefined();
  },
);

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

it("deploys only main; branch and pull-request previews are disabled", () => {
  const expected = { deploymentEnabled: { "**": false, main: true } };
  expect(config.git).toEqual(expected);
  for (const project of ["journalist-site", "reader-site"]) {
    const projectConfig = JSON.parse(readFileSync(new URL(`../../../../${project}/vercel.json`, import.meta.url), "utf8"));
    expect(projectConfig.git).toEqual(expected);
  }
});

it("leaves newsletter dispatch unscheduled while retaining its reader route", () => {
  expect(config).not.toHaveProperty("crons");
  expect(serviceFor("/reader/api/newsletter/dispatch")).toBe("reader-site");
});

it.each([
  "/reader",
  "/reader/",
  "/reader/api/editions",
  "/reader/api/editions/seattle-wa",
  "/reader/api/locations/search",
  "/reader/api/locations/seattle-wa/interest",
  "/reader/api/newsletter/dispatch",
  "/reader/api/newsletter/preferences",
  "/reader/api/newsletter/unsubscribe",
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
  "/locations",
  "/drive-diagnostics",
  "/clear-data",
  "/api/auth/callback/google",
  "/api/admin/locations",
  "/api/pipeline/advance",
  "/api/pipeline/tick",
  "/_next/static/app.js",
  "/reader-other",
])("keeps %s in the journalist service", (path) => {
  expect(serviceFor(path)).toBe("journalist-site");
});
