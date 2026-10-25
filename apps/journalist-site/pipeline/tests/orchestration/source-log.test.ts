import { describe, expect, it, vi } from "vitest";
import { itemsBySection, logRunSources, sourceCategory, textTable } from "../../orchestration/source-log";
import { SOURCE_TYPES } from "../../connectors/types";

describe("source log", () => {
  it("names a category for every source type", () => {
    for (const type of SOURCE_TYPES) expect(sourceCategory(type)).not.toMatch(/^Other/);
    expect(sourceCategory("unknown")).toBe("Other / unknown");
  });

  it("counts items by reader tab", () => {
    expect(itemsBySection(["event", "event", "meeting_outcome", "state_news"])).toBe("Events 2, Council 1, Top News 1");
    expect(itemsBySection([])).toBe("none");
  });

  it("aligns columns and shortens long cells", () => {
    const table = textTable(["#", "Source"], [["1", "Library"], ["10", "x".repeat(100)]], 20);
    const lines = table.split("\n");
    expect(lines[0]).toBe("#  | Source");
    expect(lines[2]).toBe("1  | Library");
    expect(lines[3].endsWith("…")).toBe(true);
    expect(lines[3].length).toBeLessThanOrEqual(25);
  });

  it("prints every queued source with its category", () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const location = { id: "ballard-seattle-wa", name: "Ballard, WA", state: "WA", systems: [] };
    logRunSources(location, "run1", [
      { source_id: "library:spl", name: "Seattle Public Library", type: "library" },
      { source_id: "meetings", name: "Seattle City Council", type: "meetings" },
    ]);
    const output = String(print.mock.calls[0][0]);
    print.mockRestore();
    expect(output).toContain("run run1 for Ballard, WA, 2 sources queued");
    expect(output).toContain("Events / Library");
    expect(output).toContain("Council / Public meetings");
  });
});
