import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

async function pageSignals(ids: string[], subPage = false, articleStoryId?: string) {
  const source = await readFile(new URL("../../../../reader-site/src/components/edition/NeighborhoodPage.astro", import.meta.url), "utf8");
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Reader tracking script is missing");
  const listeners = new Map<string, (event: { target: unknown }) => void>();
  const main = {
    dataset: { apiUrl: "/reader", locationId: "ballard-wa", editionId: "old-edition", trackView: String(!subPage), articleStoryId },
    querySelectorAll: vi.fn(() => ids.map((storyId) => ({ dataset: { storyId } }))),
  };
  class Element {
    closest() { return { dataset: { storyId: "story-a" } }; }
  }
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  runInNewContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    document: {
      querySelector: () => main,
      addEventListener: (name: string, handler: (event: { target: unknown }) => void) => listeners.set(name, handler),
    },
    fetch, Element,
  });
  return { main, fetch, click: (target: unknown = new Element()) => listeners.get("click")?.({ target }) };
}

describe("reader signals after moving the edition into components", () => {
  it("counts empty published editions as one read", async () => {
    const { fetch } = await pageSignals([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      location_id: "ballard-wa", edition_id: "old-edition", action: "view", story_ids: [],
    });
  });

  it("deduplicates visible preview story IDs", async () => {
    const { fetch, main } = await pageSignals(["story-a", "story-a", "story-b"]);
    expect(main.querySelectorAll).toHaveBeenCalledWith("[data-story-id]");
    expect(JSON.parse(fetch.mock.calls[0][1].body).story_ids).toEqual(["story-a", "story-b"]);
  });

  it("counts opening the full article in its exact edition without another edition read", async () => {
    const { fetch } = await pageSignals([], true, "story-a");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/reader/api/engagement");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      location_id: "ballard-wa", edition_id: "old-edition", action: "open", story_id: "story-a",
    });
  });

  it("does not count section navigation or previews as article opens", async () => {
    const { fetch, click } = await pageSignals([], true);
    click();
    expect(fetch).not.toHaveBeenCalled();
  });
});
