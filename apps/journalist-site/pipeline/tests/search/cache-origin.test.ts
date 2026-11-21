import type { Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../core/config";
import { ExecutionBlocked } from "../../core/execution-errors";
import { defaultRunOptions, withRunContext } from "../../core/run-options";
import { exploreSite, findSimilar, search, type QueryRecord } from "../../search/provider";
import { paidCall } from "../../trace/gateway";

vi.mock("../../trace/gateway", () => ({
  paidCall: vi.fn(async (_provider, operation) => ({ value: await operation(), refused: null })),
}));

const start = Date.parse("2026-01-01T00:00:00Z");
const day = 86400_000;
let rows: QueryRecord[];
function matches(row: Record<string, unknown>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((branch: Record<string, any>) => matches(row, branch));
    if (value && typeof value === "object") return Object.entries(value).every(([op, bound]) => {
      if (op === "$exists") return (row[key] !== undefined) === bound;
      if (op === "$gt") return typeof row[key] === "number" && row[key] > (bound as number);
      if (op === "$lte") return typeof row[key] === "number" && row[key] <= (bound as number);
      throw new Error(`Unexpected filter operator ${op}`);
    });
    return row[key] === value;
  });
}
const collection = {
  findOne: vi.fn(async (filter) => [...rows].reverse().find((row) => matches(row, filter)) ?? null),
  insertOne: vi.fn(async (row: QueryRecord) => { rows.push(row); return { insertedId: rows.length }; }),
};
const db = { collection: () => collection } as unknown as Db;
const settings = loadSettings({ NEWSBEE_EXA_API_KEY: "not-live", NEWSBEE_TAVILY_API_KEY: "not-live" });
const transport = vi.fn(async () => ({
  url: "https://provider.test", status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
    results: [{ url: "https://example.test/lead", title: "Local lead" }],
  })),
}));
const operations = {
  search: () => search({ db, settings, transport, query: "local news", topic: "news", family: "news", stage: "stage1", provider: "exa" }),
  findSimilar: () => findSimilar({ db, settings, transport, url: "https://example.test/story", topic: "news", family: "news" }),
  exploreSite: () => exploreSite({ db, settings, transport, url: "https://example.test", instruction: "find news", topic: "news", family: "news" }),
};
beforeEach(() => {
  rows = [];
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(start);
});
afterEach(() => vi.restoreAllMocks());

describe.each(Object.entries(operations))("%s origin freshness", (_name, operation) => {
  it("expires at the original seven-day boundary despite intermediate hits", async () => {
    await operation();
    vi.mocked(Date.now).mockReturnValue(start + 6 * day);
    await operation();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(rows[1]).toMatchObject({ cached: true, created_at: (start + 6 * day) / 1000, provider_fetched_at: start / 1000 });
    vi.mocked(Date.now).mockReturnValue(start + 7 * day);
    await operation();
    expect(transport).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockReturnValue(start + 12 * day);
    await operation();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(rows[3].provider_fetched_at).toBe((start + 7 * day) / 1000);
    expect(paidCall).toHaveBeenCalledTimes(2);
  });

  it("does not trust legacy cached rows, but preserves origin from a legacy direct fetch", async () => {
    await operation();
    delete rows[0].provider_fetched_at;
    vi.mocked(Date.now).mockReturnValue(start + 6 * day);
    await operation();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(rows[1].provider_fetched_at).toBe(start / 1000);
    rows = [{ ...rows[1], provider_fetched_at: undefined }];
    await operation();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(rows[1].cached).toBe(false);
  });

  it("does not cache failed or refused calls as successful empty results", async () => {
    vi.mocked(paidCall).mockRejectedValueOnce(new Error("usage recording failed"));
    expect(await operation()).toMatchObject({ error: "usage recording failed" });
    expect(rows[0].provider_fetched_at).toBeNull();
    vi.mocked(paidCall).mockResolvedValueOnce({ value: null, refused: "budget unavailable" });
    expect(await operation()).toMatchObject({ skipped: "budget unavailable" });
    expect(rows[1].provider_fetched_at).toBeNull();
    await operation();
    expect(rows[2].cached).toBe(false);
    expect(paidCall).toHaveBeenCalledTimes(3);
  });

  it("propagates deadline/admission failures without pretending a query completed", async () => {
    vi.mocked(paidCall).mockRejectedValueOnce(new ExecutionBlocked("execution deadline"));
    await expect(operation()).rejects.toThrow("execution deadline");
    expect(rows).toHaveLength(0);
  });

  it("retains isolated map-run scope and per-use attribution", async () => {
    const scoped = (runId: string) => withRunContext({
      db, runId, locationId: "town", runKind: "map", isolated: true, options: defaultRunOptions({}),
    }, operation);
    await scoped("first");
    await scoped("second");
    await scoped("first");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => [row.run_id, row.location_id, row.cached])).toEqual([
      ["first", "town", false], ["second", "town", false], ["first", "town", true],
    ]);
  });
});

it("keeps request exclusions in exploration cache identity", async () => {
  const input = { db, settings, transport, url: "https://example.test", instruction: "find news", topic: null, family: "news" };
  await exploreSite({ ...input, exclude: ["first.test"] });
  await exploreSite({ ...input, exclude: ["second.test"] });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(rows[0].key).not.toBe(rows[1].key);
});
