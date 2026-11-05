import { describe, expect, it } from "vitest";
import { isLocalQuery, stage1Queries, stage2Queries, type SearchKit } from "../../discovery/topics";

const TOPICS = ["crime", "deaths", "events", "home_sales", "sports"] as const;
const kit = (place: string, parent: string | null): SearchKit => ({
  place, parent, state: "Washington", stateCode: "WA", county: "Grant", cityDomain: "city.example.gov", zips: ["98000"],
  schools: [{ name: "North High School", host: "north.example.org" }],
  institutions: [{ name: "Valley Funeral Chapel", kind: "funeral_directors", website: null, inside: true } as SearchKit["institutions"][number]],
  venues: ["Riverside Hall"], agencyHosts: ["police.example.gov"], funeralHosts: ["chapel.example.com"], schoolHosts: ["north.example.org"], teamHosts: [], savedHosts: [], associationHost: null,
});
const sites = new Set(["city.example.gov", "police.example.gov", "chapel.example.com", "north.example.org"]);

describe("isLocalQuery", () => {
  const neighbourhood = kit("Northgate", "Lakeside");

  it("accepts a query tied to the place, its city, a ZIP, an institution or a confirmed site", () => {
    for (const query of ['"Northgate" police reports', '"Lakeside" police blotter', "98000 permits", '"Valley Funeral Chapel" obituaries', "site:city.example.gov agenda", "site:www.city.example.gov/news minutes"]) expect(isLocalQuery(neighbourhood, query, sites), query).toBe(true);
  });

  it("refuses a query that only names the county, state or metro", () => {
    for (const query of ['"Grant County" sheriff press release', '"Washington" liquor license applications', '"Metro City" official team schedule', 'site:.gov "Washington" permit', "site:unknown.example.com news", "police -site:city.example.gov"]) expect(isLocalQuery(neighbourhood, query, sites), query).toBe(false);
  });
});

describe("generated queries", () => {
  it.each([["a neighbourhood", kit("Northgate", "Lakeside")], ["a town", kit("Northgate", null)]])("stay local for %s", (_, area) => {
    const planned = [...stage1Queries(area, [...TOPICS], 200), ...TOPICS.flatMap((topic) => stage2Queries(area, topic, "2026-10-01", 20))];
    expect(planned.length).toBeGreaterThan(20);
    for (const { query } of planned) expect(isLocalQuery(area, query, sites), query).toBe(true);
    expect(planned.some(({ query }) => /\b(MLB|NFL|NBA|WNBA|NHL|MLS|NWSL)\b/.test(query))).toBe(false);
  });

  it("names the state only beside a local name", () => {
    const planned = stage1Queries(kit("Northgate", "Lakeside"), [...TOPICS], 200);
    expect(planned.some(({ query }) => /^"Washington"/.test(query))).toBe(false);
  });
});
