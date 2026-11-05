import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";

export default defineConfig({
  base: "/reader",
  adapter: vercel(),
  output: "server",
  devToolbar: { enabled: false },
  // shared/ lives outside this app; let the dev server read it (design tokens, data helpers).
  vite: { server: { strictPort: true, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } } },
});
