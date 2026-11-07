import { expect, it, vi } from "vitest";
import { methodDefinition, type DiscoveryContext } from "../../discovery/methods";
import { loadSettings } from "../../core/config";
import { logger } from "../../core/log";

vi.mock("../../model/budget", async (original) => ({ ...await original<object>(), canSpend: async () => true, groundedSearch: async () => null }));

it("reports an uninstalled local model before generation or suggestion-page requests", async () => {
  const generateStructured = vi.fn();
  const getText = vi.fn();
  const context = { settings: loadSettings({} as NodeJS.ProcessEnv), db: {}, location: { id: "test", name: "Example, WA", state: "WA", systems: [], government: null }, today: "2026-11-06", log: logger("test"), fetcher: { getText }, model: { provider: "ollama", health: async () => ({ status: "unavailable", detail: "model missing" }), generateStructured } } as unknown as DiscoveryContext;
  await expect(methodDefinition("llm")!.run(context)).rejects.toThrow("Discovery model is not ready");
  expect(generateStructured).not.toHaveBeenCalled();
  expect(getText).not.toHaveBeenCalled();
});

it("requires item locality even when a model calls a parent-city source local", async () => {
  const context = { settings: loadSettings({} as NodeJS.ProcessEnv), db: {}, location: { id: "test", name: "Wedgwood, WA", state: "WA", systems: [], government: null, community: { name: "Wedgwood", parent_name: "Seattle" } }, today: "2026-11-06", log: logger("test"), fetcher: { getText: async () => ["https://city.example.org/", "<main>Seattle news</main>"] }, model: { provider: "fake", generateStructured: async () => ({ response: JSON.stringify({ sources: [{ url: "https://city.example.org/", name: "Seattle news", section: "news", located_inside: true }] }) }) } } as unknown as DiscoveryContext;
  const result = await methodDefinition("llm")!.run(context);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0].inside_area).toBe(false);
  expect(result.candidates[0].params.inside_area).toBe(false);
});
