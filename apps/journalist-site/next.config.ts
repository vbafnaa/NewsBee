import type { NextConfig } from "next";

const config: NextConfig = {
  // Loaded from node_modules at run time: its DOM isn't meant to be bundled.
  serverExternalPackages: ["linkedom"],
  // The mapping agent reads its instructions from the skill at run time.
  outputFileTracingIncludes: { "/**/*": ["../../skills/map-sources/SKILL.md"] },
};

export default config;
