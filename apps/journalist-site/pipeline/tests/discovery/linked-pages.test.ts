import { describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { linkedPages } from "../../discovery/linked-pages";
import { upsertCandidates, type SourceCandidate } from "../../sourcemap/store";

const parent: SourceCandidate = { source_id: "root", name: "Community school", url: "https://school.example.org/", reader: "web", section: "schools", params: {}, inside_area: false, found_by: { method: "llm", detail: "checked model suggestion" } };
const page = (date: string) => `<main><p>${"School and community announcements for neighbors. ".repeat(5)}</p><time datetime="${date}">${date}</time></main>`;

describe("observed source navigation", () => {
  it("preserves distinct pages, prioritizes the neighborhood and never inherits locality", async () => {
    const fetcher = { getText: vi.fn(async (url: string): Promise<[string, string]> => [url, page("2026-11-06")]) };
    const html = '<a href="/news">News</a><a href="/calendar">Calendar</a><a href="/wedgwood-newsletter">Wedgwood newsletter</a><a href="https://unrelated.org/events">Events</a>';
    const result = await linkedPages(fetcher, { ...parent, inside_area: true }, html, "2026-11-06", "Wedgwood", 3);
    expect(fetcher.getText.mock.calls[0][0]).toContain("wedgwood-newsletter");
    expect(result.candidates).toHaveLength(3);
    expect(new Set(result.candidates.map((x) => x.source_id)).size).toBe(3);
    expect(result.candidates.every((x) => !x.inside_area && x.params.inside_area === false)).toBe(true);
    expect(result.candidates.every((x) => x.params.discovery_parent_url === parent.url)).toBe(true);
    expect(fetcher.getText.mock.calls.every(([url]) => !url.includes("unrelated"))).toBe(true);
  });
  it("does not turn blocked, thin, stale or redirected-to-root links into sources", async () => {
    const fetcher = { getText: vi.fn(async (url: string): Promise<[string, string]> => {
      if (url.endsWith("blocked-events")) throw new Error("robots blocked");
      if (url.endsWith("thin-news")) return [url, "not found"];
      if (url.endsWith("old-news")) return [url, page("2020-01-01") + page("2020-02-01") + page("2020-03-01")];
      return [parent.url!, page("2026-11-06")];
    }) };
    const html = ["blocked-events", "thin-news", "old-news", "redirect-calendar"].map((p) => `<a href="/${p}">${p}</a>`).join("");
    const result = await linkedPages(fetcher, parent, html, "2026-11-06", "Wedgwood", 4);
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toHaveLength(3);
  });
  it("keeps undated lookup pages as link-only, not as collectible stories", async () => {
    const result = await linkedPages({ getText: async (url) => [url, `<form>Search by parcel</form>${page("2020-01-01")}`] }, parent, '<a href="/assessor">Assessor</a>', "2026-11-06", "Wedgwood");
    expect(result.candidates[0].link_only).toBe(true);
  });
});

it("retains validated distinct pages and explicit editor additions beyond the root-host cap", async () => {
  const updateOne = vi.fn(async () => ({}));
  const db = { collection: () => ({ findOne: async () => null, countDocuments: async () => 2, updateOne }) } as unknown as Db;
  expect(await upsertCandidates(db, "place", [{ ...parent, source_id: "generic" }])).toBe(0);
  expect(await upsertCandidates(db, "place", [{ ...parent, source_id: "calendar", source_kind: "calendar", params: { discovery_parent_url: parent.url } }])).toBe(1);
  expect(await upsertCandidates(db, "place", [{ ...parent, source_id: "editor", status: "pinned", found_by: { method: "editor", detail: "verified registry entry" } }])).toBe(1);
  expect(updateOne).toHaveBeenCalledTimes(2);
});
