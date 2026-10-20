import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";

export default defineConfig({
  adapter: vercel(),
  output: "server",
  devToolbar: { enabled: false },
  vite: { server: { strictPort: true } },
});
