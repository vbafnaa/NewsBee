import type { NextConfig } from "next";

const config: NextConfig = {
  // Loaded from node_modules at run time: its DOM isn't meant to be bundled.
  serverExternalPackages: ["linkedom"],
};

export default config;
