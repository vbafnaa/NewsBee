import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Loaded from node_modules at run time: its DOM isn't meant to be bundled.
  serverExternalPackages: ["linkedom"],
  // Shared contracts and native photo tooling live in this repository, not a parent workspace.
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  // Local databases, research snapshots and private configuration are not deployment assets.
  outputFileTracingExcludes: { "/*": ["../../.local/**/*", "../../.git/**/*"] },
};

export default config;
