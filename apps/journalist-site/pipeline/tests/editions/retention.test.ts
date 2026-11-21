import type { Db } from "mongodb";
import { expect, it, vi } from "vitest";
import { ensureItemIndexes } from "../../editions/assemble";
import { collectedItemExpiration, dryRunCollectedItemRetention } from "../../editions/retention";

const created = Date.parse("2026-01-01T00:00:00Z") / 1000;
const expires = new Date("2026-04-01T00:00:00Z");
function database(rows: Record<string, unknown>[]) {
  const cursor = { sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn(async () => rows) };
  const collection = { find: vi.fn((_filter: unknown, _options: unknown) => cursor), createIndexes: vi.fn(async (_indexes: Record<string, unknown>[]) => []) };
  return { db: { collection: () => collection } as unknown as Db, collection, cursor };
}
const review = { complete: true, retainedItemIds: new Set<string>(), retainedRunIds: new Set<string>(), retainedStoryIds: new Set<string>() };

it("computes a BSON-compatible Date without changing epoch-second timestamps or enabling TTL", async () => {
  expect(collectedItemExpiration(created)).toEqual(expires);
  const { db, collection } = database([]);
  await ensureItemIndexes(db);
  const indexes = collection.createIndexes.mock.calls[0][0] as unknown as Record<string, unknown>[];
  expect(indexes.some((index) => "expireAfterSeconds" in index)).toBe(false);
  expect(indexes).toContainEqual({ key: { retention_expires_at: 1 }, name: "collected_item_retention_inventory" });
});

it("fails closed on historical evidence until reference review completes", async () => {
  const { db } = database([{ _id: "old", run_id: "run", created_at: created }]);
  expect(await dryRunCollectedItemRetention(db)).toMatchObject({
    deletionEnabled: false, dryRun: true, rows: [{ id: "old", action: "blocked", reason: "reference_review_incomplete" }],
  });
});

it("retains item, run and story references, proposes only unreferenced dates, and is restartable", async () => {
  const rows = [
    { _id: "item", run_id: "run", created_at: created },
    { _id: "run-ref", run_id: "kept-run", created_at: created },
    { _id: "story-ref", run_id: "run", story_id: "kept-story", created_at: created },
    { _id: "new", run_id: "run", created_at: created },
    { _id: "already", run_id: "run", created_at: created, retention_expires_at: expires },
    { _id: "conflict", run_id: "run", created_at: created, retention_expires_at: new Date(0) },
    { _id: "bad", run_id: "run", created_at: NaN },
  ];
  const { db, collection, cursor } = database(rows);
  const checked = { ...review, retainedItemIds: new Set(["item"]), retainedRunIds: new Set(["kept-run"]), retainedStoryIds: new Set(["kept-story"]) };
  const first = await dryRunCollectedItemRetention(db, { review: checked, asOf: new Date("2026-05-01"), afterId: "cursor", limit: 5000 });
  expect(cursor.limit).toHaveBeenCalledWith(500);
  expect(collection.find).toHaveBeenCalledWith({ _id: { $gt: "cursor" } }, expect.anything());
  expect(first.rows.slice(0, 3)).toEqual(["item", "run-ref", "story-ref"].map((id) => ({ id, action: "retain", reason: "retained_reference" })));
  expect(first.rows.slice(3)).toEqual([
    { id: "new", action: "propose_backfill", expiresAt: expires, overdue: true },
    { id: "already", action: "unchanged", expiresAt: expires, overdue: true },
    { id: "conflict", action: "blocked", reason: "expiration_conflict" },
    { id: "bad", action: "blocked", reason: "invalid_created_at" },
  ]);
  expect(await dryRunCollectedItemRetention(db, { review: checked, asOf: new Date("2026-05-01"), afterId: "cursor", limit: 5000 })).toEqual(first);
  expect(rows[3]).not.toHaveProperty("retention_expires_at");
});
