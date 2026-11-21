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

function originalDiversify(candidates: Refined[], points = 4) {
  const remaining = structuredClone(candidates), chosen: Refined[] = [];
  while (remaining.length) {
    let bestIndex = 0, bestValue = -Infinity, bestPenalty = 0;
    remaining.forEach((item, index) => {
      const penalty = chosen.length ? points * Math.max(...chosen.map(other => similarity(item, other))) : 0;
      const value = item.explain.final - penalty;
      if (value > bestValue + 1e-9) { bestValue = value; bestIndex = index; bestPenalty = penalty; }
    });
    const [item] = remaining.splice(bestIndex, 1);
    item.explain.diversity_penalty = Math.round(bestPenalty * 1000) / 1000;
    chosen.push(item);
  }
  return chosen;
}

it.each([0, 1, 2, 30, 60])("preserves exact MMR order, ties and explanation penalties at %i candidates", count => {
  for (let seed = 0; seed < 10; seed++) {
    const items = Array.from({ length: count }, (_, i) => ({
      ...candidate(`${seed}:${i}`, i % 4 ? `publisher-${i % 5}` : "", 20 - ((i * 13 + seed) % 7)),
      title: ["Town council approves budget", "Town council approves budget", "School arts night", "", "Library books and authors"][i % 5],
    }));
    const metrics = { comparisons: 0 };
    expect(diversify(structuredClone(items), 4, metrics)).toEqual(originalDiversify(items));
    expect(metrics.comparisons).toBe(Math.max(0, count * (count - 1) / 2));
  }
});
