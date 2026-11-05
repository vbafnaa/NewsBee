import { describe, expect, it } from "vitest";
import { defaultRunOptions, itemCap, LEGACY_OPTIONS, limits, withRunContext, type RunOptions } from "../../core/run-options";
import type { Db } from "mongodb";

const within = <T>(options: RunOptions, operation: () => T) => withRunContext({ db: {} as Db, runId: "run-1", locationId: "ballard", options }, operation);

describe("caps", () => {
  it("are off unless NEWSBEE_GUARDRAILS_OFF says otherwise", () => {
    expect(defaultRunOptions({} as NodeJS.ProcessEnv).guardrails_off).toEqual(["caps"]);
    expect(defaultRunOptions({ NEWSBEE_GUARDRAILS_OFF: "none" } as unknown as NodeJS.ProcessEnv).guardrails_off).toEqual([]);
    expect(defaultRunOptions({ NEWSBEE_GUARDRAILS_OFF: "quality" } as unknown as NodeJS.ProcessEnv).guardrails_off).toEqual(["quality"]);
  });

  it("set no limit at all while they are off, and upstream's limits while they are on", () => {
    const off = within({ ...LEGACY_OPTIONS, guardrails_off: ["caps"] }, () => ({ limits: limits(), item: itemCap(5) }));
    expect(Object.values(off.limits).every((value) => value === Infinity)).toBe(true);
    expect(off.item).toBe(Infinity);
    const on = within(LEGACY_OPTIONS, () => ({ limits: limits(), item: itemCap(5) }));
    expect(on.limits).toMatchObject({ publishedPerSection: 10, candidatesPerSection: 20, webPageBudget: 10 });
    expect(on.item).toBe(5);
  });
});
