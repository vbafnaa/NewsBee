import { expect, it } from "vitest";
import { diversify, parseOrder, similarity, type Refined } from "../../ranking/edition-ranker";

function candidate(id: string, source: string, score: number): Refined {
  return { id, title: id, occurrences: 1, venues: [], first_date: "2026-11-08", source_type: "web", source_id: source,
    rating: { id, category: "other", civic: 1, appeal: 1, special: 1 }, score, rated_by: "model",
    explain: { base: score, category: "other", engagement: { multiplier: 1, views: 0, successes: 0, sampled: 0 }, rerank: { position: null, bonus: 0 }, diversity_penalty: 0, final: score } };
}
it("does not mistake independent web publishers for the same source", () => {
  const council = candidate("Budget", "web:council", 10);
  const councilAgain = candidate("Roads", "web:council", 9);
  const library = candidate("Books", "web:library", 8.5);
  expect(similarity(council, councilAgain)).toBe(0.8);
  expect(similarity(council, library)).toBe(0.5);
  expect(diversify([council, councilAgain, library]).map((item) => item.id)).toEqual(["Budget", "Books", "Roads"]);
});
it("does not give missing source identities a same-source penalty", () => {
  const first = candidate("Budget", "", 10), second = candidate("Books", "", 9);
  expect(similarity(first, second)).toBe(0.5);
});
it("keeps each real candidate once despite repeated, invented or omitted model IDs", () => {
  expect(parseOrder({ order: ["c", "c", "invented", "a"] }, ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  expect(() => parseOrder({ order: ["invented"] }, ["a", "b", "c"])).toThrow("left out most candidates");
});
