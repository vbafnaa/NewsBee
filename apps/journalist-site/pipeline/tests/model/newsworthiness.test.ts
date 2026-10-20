import { describe, expect, it } from "vitest";
import * as ranking from "../../model/newsworthiness";
import { FakeModel } from "../support/fake-model";

const candidate = (id: string, extra: Partial<ranking.Candidate> = {}): ranking.Candidate => ({ id, title: id, description: "Useful local information.", occurrences: 1, venues: ["Town Hall"], first_date: "2026-11-03", ...extra });

describe("newsworthiness", () => {
  it("retries only missing ratings before using deterministic fallback", async () => {
    const model = new FakeModel(({ prompt }) => {
      const data = JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{id:string}>;
      return { ratings: [{ id: data[0].id, category: "civic_and_practical", civic: 2, appeal: 1, special: 0 }] };
    });
    const [ranked, report] = await ranking.rank(model, [candidate("a"), candidate("b", { kind: "meeting_preview", occurrences: 2 })]);
    expect(ranked.map((item) => [item.id, item.score, item.rated_by])).toEqual([["a", 8, "model"], ["b", 8, "model"]]);
    expect(report).toMatchObject({ policy: ranking.RANKING_POLICY, candidates: 2, batches: 1, fallback_ratings: 0 });
    expect(model.calls).toHaveLength(2);
    const retried = JSON.parse(model.calls[1].prompt.split("\nCandidates:\n")[1]);
    expect(retried.map((item: { id: string }) => item.id)).toEqual(["b"]);
    expect(model.calls[0].options).toMatchObject({ numCtx: 8192, numPredict: 1800, keepAlive: "10m" });
  });
  it("evaluates the full expanded pool in bounded batches, preserving description evidence", async () => {
    const values = Array.from({ length: 75 }, (_, index) => candidate(`item-${index}`, { description: `${"Source detail. ".repeat(30)}Important town budget change.` }));
    const model = new FakeModel(({ prompt }) => {
      const batch = JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string }>;
      expect(batch.length).toBeLessThanOrEqual(12);
      return { ratings: batch.map(({ id }) => ({ id, category: "other", civic: id === "item-74" ? 3 : 0, appeal: 0, special: 0 })) };
    });
    const [ranked, report] = await ranking.rank(model, values);
    expect(report).toMatchObject({ candidates: 75, batches: 7, fallback_ratings: 0 });
    expect(ranked[0].id).toBe("item-74");
    expect(model.calls[0].prompt).toContain("Important town budget change");
  });
  it("reports persistent missing/invalid IDs instead of accepting fabricated or duplicate ratings", async () => {
    const model = new FakeModel(() => ({ ratings: [
      { id: "not-requested", category: "other", civic: 3, appeal: 3, special: 3 },
    ] }));
    const [ranked, report] = await ranking.rank(model, [candidate("a")]);
    expect(ranked[0].rated_by).toBe("rule");
    expect(report).toMatchObject({ fallback_ratings: 1, batch_reports: [{ attempts: 2, errors: expect.arrayContaining([expect.stringContaining("unexpected or duplicate")]) }] });
  });
  it("uses meeting fallback and emits kind and area in prompt", async () => {
    const model = new FakeModel(() => new Error("invalid JSON"));
    const [ranked] = await ranking.rank(model, [candidate("event"), candidate("meeting", { kind: "meeting_outcome", tier: "region" })]);
    expect(ranked.map((entry) => [entry.id, entry.score])).toEqual([["meeting", 10], ["event", 1]]);
    const prompt = model.calls[0].prompt;
    expect(prompt).toContain('"kind": "meeting_outcome", "area": "county"');
    expect(prompt).toContain("trending_topics");
  });
  it("breaks equal cross-source ratings by one-off, soonest event and newest news", async () => {
    const values = [
      candidate("later-event", { first_date: "2026-11-05" }),
      candidate("newer-news", { first_date: "2026-10-30", kind: "state_news" }),
      candidate("earlier-event", { first_date: "2026-11-02" }),
      candidate("older-news", { first_date: "2026-10-28", kind: "earthquake" }),
    ];
    const model = new FakeModel(({ prompt }) => {
      const data = JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string }>;
      return { ratings: data.map(({ id }) => ({ id, category: "other", civic: 1, appeal: 0, special: 0 })) };
    });
    const [ranked] = await ranking.rank(model, values);
    expect(ranked.map((item) => item.id)).toEqual(["newer-news", "older-news", "earlier-event", "later-event"]);
  });

});
