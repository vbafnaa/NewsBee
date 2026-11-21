import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { PublicationPreview } from "../../../../../shared/publication-preview";

it("renders the actual Reader home, article, and section through the authenticated same-host bridge", async () => {
  const { default: dev } = await import("../../../../reader-site/node_modules/astro/dist/core/dev/index.js");
  // Astro intentionally omits its HTTP renderer in Vitest unless this flag is cleared during setup.
  const vitest = process.env.VITEST;
  delete process.env.VITEST;
  let reader: Awaited<ReturnType<typeof dev>>;
  try {
    reader = await dev({
      root: new URL("../../../../reader-site/", import.meta.url),
      logLevel: "silent", server: { host: "127.0.0.1", port: 0 },
      vite: { optimizeDeps: { noDiscovery: true, include: [] } },
    });
  } finally {
    if (vitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = vitest;
  }
  const payload: PublicationPreview = {
    kind: "publication-draft-preview",
    publication: {
      id: "private-paper", profile_revision: 1, display_name: "Private Weekly",
      description: "Independent local reporting.", homepage_url: null, logo_url: null,
    },
    sponsor_placements: { revision: 1, placements: [] },
    snapshot: {
      schema_version: 1, draft_id: "selected-draft", draft_revision: 8,
      title: "Not yet published", intro: "Private intro",
      save_the_bee: { word: "CLOVER", clue: "A plant with three little leaves." },
      window_start: "2026-11-09", window_end: "2026-11-15",
      locations: [{ id: "north-wa", name: "North, WA" }],
      sections: [{ id: "community", title: "Community reporting" }], correction: null,
      items: [{
        item_id: "private-story", story_id: "private-story", origin: "original", source_references: [],
        location_ids: ["north-wa"], location_names: ["North, WA"],
        section_id: "community", section_title: "Community reporting",
        headline: "Confidential library reporting", blurb: "Full private reporting before publication.",
        byline: "Local Reporter", when_where: "", event_date: "2026-11-09",
        source_url: "https://library.example.test/news",
        sources: [{ name: "Library", url: "https://library.example.test/news" }], rank: 1, kind: "local_news",
      }],
    },
  };
  payload.snapshot.items.push({
    ...payload.snapshot.items[0], item_id: "private-event", story_id: "private-event", rank: 2,
    kind: "event", headline: "Private reading event", blurb: "Details of the selected draft event.",
    when_where: "When: Tuesday, November 10, 2 - 3pm. Where: Library, North.",
    event_date: "2026-11-10",
  });
  const bridgeRequests: string[] = [];
  const proxy = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/api/admin/")) {
        bridgeRequests.push(request.url);
        response.setHeader("Content-Type", "application/json");
        response.statusCode = request.headers.cookie === "authjs.session-token=signed" ? 200 : 401;
        response.end(JSON.stringify(response.statusCode === 200 ? payload : { detail: "Sign in." }));
        return;
      }
      reader.handle(request, response);
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  try {
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const page = "/reader/publications/private-paper/drafts/selected-draft?revision=8";
    for (const suffix of ["", "&story=private-story", "&section=community", "&section=all", "&section=events&day=2026-11-10"]) {
      const response = await fetch(`${origin}${page}${suffix}`, { headers: { cookie: "authjs.session-token=signed" } });
      const html = await response.text();
      expect(response.status, html.slice(0, 1000)).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
      expect(html).toContain("Private draft preview");
      expect(html).toContain("not published");
      expect(html).toContain(suffix.includes("events") ? "Private reading event" : "Confidential library reporting");
      expect(html).not.toContain("googletagmanager");
      expect(html).not.toContain("/releases/");
      expect(html).not.toContain("Share this release");
      if (suffix === "&story=private-story") {
        expect(html).toContain('class="full-story"');
        expect(html).toContain("Full private reporting before publication.");
        expect(html).toContain("Local Reporter");
      }
      if (suffix === "") {
        expect(html).toContain('class="release-heading"');
        expect(html).toContain("Guide the Bee Home");
        expect(html).toContain("publication=private-paper");
        expect(html).toContain("draft=selected-draft");
        expect(html).toContain("revision=8");
        expect(html).not.toContain("CLOVER");
      }
    }
    const denied = await fetch(`${origin}${page}`);
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("Confidential library reporting");
    const missing = await fetch(`${origin}${page}&story=unrelated`, { headers: { cookie: "authjs.session-token=signed" } });
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("Confidential library reporting");
    expect(bridgeRequests.every((url) => url === "/api/admin/publications/private-paper/drafts/selected-draft/preview?revision=8")).toBe(true);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await reader.stop();
  }
}, 120_000);
