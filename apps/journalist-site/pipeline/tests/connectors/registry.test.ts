/**
 * Contract for the self-describing connector registry: every registered connector
 * describes itself completely, and everything derived from the registry stays in step.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONNECTORS, SOURCE_TYPES, connectorFor, coverageTypes, storyKinds } from "../../connectors/registry";
import { rankerFor, soonest } from "../../ranking";
import { editionCoverage } from "../../editions/authoring";
import { sourceResult } from "../../connectors/types";
import { ALL_KINDS, NEWS_KINDS, NEWS_LINES } from "../../editorial/kinds";

const schema = JSON.parse(readFileSync(new URL("../../../../../shared/contracts/edition.schema.json", import.meta.url), "utf8"));
const contractKinds: string[] = schema.$defs.EditionItem.properties.kind.enum;

describe("connector registry", () => {
  it.each(SOURCE_TYPES)("%s describes itself completely", (type) => {
    const connector = CONNECTORS[type];
    expect(connector.type).toBe(type);
    expect(connector.meta.name.trim()).not.toBe("");
    expect(connector.meta.formats.trim()).not.toBe("");
    expect(typeof connector.meta.manual).toBe("boolean");
    expect(["local", "wider", "parents"]).toContain(connector.meta.coverage.group);
    expect(connector.meta.coverage.label.trim()).not.toBe("");
    expect(connector.meta.storyKinds.length).toBeGreaterThan(0);
    expect(connector.window.back ?? connector.window.ahead).toBeDefined();
    for (const range of [connector.window.back, connector.window.ahead]) {
      if (!range) continue;
      const days = "days" in range ? range.days : range.maxDays;
      expect(Number.isInteger(days) && days > 0).toBe(true);
    }
    expect(typeof connector.rank).toBe("function");
    expect(rankerFor(type)).toBe(connector.rank);
  });

  it("only produces story kinds the edition contract accepts", () => {
    expect([...storyKinds()].filter((kind) => !contractKinds.includes(kind))).toEqual([]);
  });

  it("defines every story kind once, matching the edition contract and the reader type", () => {
    expect([...ALL_KINDS].sort()).toEqual([...contractKinds].sort());
    const reader = readFileSync(new URL("../../../../reader-site/src/lib/reader-data.ts", import.meta.url), "utf8");
    const union = /kind\??: ((?:"[a-z_]+"(?: \| )?)+);/.exec(reader)?.[1].match(/[a-z_]+/g) ?? [];
    expect(union.sort()).toEqual([...ALL_KINDS].sort());
    for (const kind of NEWS_KINDS) expect(NEWS_LINES[kind]).toMatch(/\{when\}/);
  });

  it("falls back to soonest-first ranking and no connector for an unknown type", () => {
    expect(connectorFor("unknown")).toBeUndefined();
    expect(rankerFor("unknown")).toBe(soonest);
  });

  it("names local sources first, then parent sources, then wider sources", () => {
    expect(coverageTypes("local").map((connector) => connector.type)).toEqual(["web", "opendata", "newssearch", "sweep", "property", "library", "meetings", "remembrance", "community"]);
    expect(coverageTypes("parents").map((connector) => connector.type)).toEqual(["homesafety", "housing"]);
    expect(coverageTypes("wider").map((connector) => connector.type)).toEqual(["hazards", "trending", "justice"]);
  });

  it("keeps the edition coverage note's wording", () => {
    const ok = (id: string) => sourceResult(id, id, "ingested", "");
    expect(editionCoverage([ok("library:a"), ok("meetings:b")])[0]).toBe("Gathered from 2 sources: library listings, public meetings.");
    expect(editionCoverage([ok("web:a"), ok("opendata:b"), sourceResult("hazards:usgs", "USGS", "failed", "")]))
      .toEqual(["Gathered from 3 sources: local websites and newsrooms, public records, weather and earthquake alerts.", "1 of 3 sources had nothing usable this week; see where this news comes from for details."]);
  });
});
