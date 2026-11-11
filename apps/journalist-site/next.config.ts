import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";
import path from "node:path";

function buildCommit() {
  const configured = process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEWSBEE_BUILD_COMMIT_SHA;
  if (configured) return configured;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(__dirname, "../.."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const config: NextConfig = {
  env: { NEWSBEE_BUILD_COMMIT_SHA: buildCommit() },
  // Loaded from node_modules at run time: its DOM isn't meant to be bundled.
  serverExternalPackages: ["linkedom"],
  // Shared contracts and native photo tooling live in this repository, not a parent workspace.
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  // Local databases, research snapshots and private configuration are not deployment assets.
  outputFileTracingExcludes: { "/*": ["../../.local/**/*", "../../.git/**/*"] },
};

export default config;
