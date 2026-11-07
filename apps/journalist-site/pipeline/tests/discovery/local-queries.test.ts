import { describe, expect, it } from "vitest";
import { isLocalQuery, stage1Queries, stage2Queries, type SearchKit } from "../../discovery/topics";
import { DORK_QUERIES } from "../../discovery/methods";
import { PAID_SERVICES, PRIORITY_TOPICS } from "../../core/run-values";
import { MAX_ROUNDS, QUERIES_PER_ROUND, TOPICS_OF } from "../../agent/map-sources";
import { ruleTier } from "../../search/classifier";
import { topicOfItem, TOPIC_SECTIONS } from "../../discovery/topics";

const TOPICS = PRIORITY_TOPICS.map((topic) => topic.id);
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
  it("includes civic, schools, community and businesses within the normal 36-query budget", () => {
    const planned = stage1Queries(kit("Northgate", "Lakeside"), [...TOPICS], 36);
    expect(planned.length).toBeLessThanOrEqual(36);
    for (const section of ["civic", "schools", "community", "business"]) expect(planned.some((query) => query.section === section)).toBe(true);
    for (const topic of TOPICS) expect(planned.some((query) => query.topic === topic)).toBe(true);
  });
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

  it("keeps every topic's share at six within the budget, taking topics in turn", () => {
    const planned = stage1Queries(kit("Northgate", "Lakeside"), [...TOPICS], DORK_QUERIES);
    expect(Math.floor(DORK_QUERIES / (TOPICS.length + 1))).toBe(6);
    for (const topic of TOPICS) {
      const mine = planned.filter((query) => query.topic === topic);
      expect(mine.length, topic).toBeGreaterThanOrEqual(3);
      expect(mine.length, topic).toBeLessThanOrEqual(6);
    }
    expect(new Set(planned.slice(0, TOPICS.length).map((query) => query.topic)).size).toBe(TOPICS.length);
  });

  it("asks for agendas, school boards, PTAs, fire, closings and volunteering by name", () => {
    const all = stage1Queries(kit("Northgate", null), [...TOPICS], DORK_QUERIES).map(({ query }) => query).join("\n");
    for (const words of ["agenda", '"public hearing"', '"school board"', "PTSA", '"fire department"', '"going out of business"', "volunteer"]) expect(all).toContain(words);
  });
});

describe("the query budget", () => {
  it("leaves the agent its own queries under each search service's default budget", () => {
    for (const id of ["serpapi", "searchapi", "brightdata", "tavily"]) {
      expect(PAID_SERVICES.find((service) => service.id === id)!.budget, id).toBeGreaterThanOrEqual(DORK_QUERIES + MAX_ROUNDS * QUERIES_PER_ROUND + 1);
    }
  });
});

describe("topics", () => {
  it("keeps the original topic ids and maps each new one to its section", () => {
    expect(TOPICS.slice(0, 5)).toEqual(["crime", "deaths", "events", "home_sales", "sports"]);
    expect(TOPIC_SECTIONS).toMatchObject({ government: "civic", schools: "schools", business: "business", community: "community", news: "news", sports: "sports" });
  });

  it("treats a school as a schools lead, and its sport as sport", () => {
    expect(TOPICS_OF.school).toBe("schools");
    expect(topicOfItem({ kind: "school_sports", section: "schools" })).toBe("sports");
    expect(topicOfItem({ kind: "local_news", section: "schools" })).toBe("schools");
    expect(topicOfItem({ kind: "meeting_preview", section: "civic" })).toBe("government");
  });
});

describe("ruleTier", () => {
  it("sees a parent group as an organisation wherever it is hosted", () => {
    expect(ruleTier("https://www.northgatepta.com/", "Northgate PTA")).toBe("organisation");
    expect(ruleTier("https://example.com/", "Northgate PTSA Newsletter")).toBe("organisation");
    expect(ruleTier("https://north-pto.net/")).toBe("organisation");
  });

  it("leaves other sites alone", () => {
    expect(ruleTier("https://crypto.com/", "Trade today")).toBe("business");
    expect(ruleTier("https://north.k12.wa.us/", "North PTA")).toBe("official");
    expect(ruleTier("https://northgateherald.com/")).toBe("local_reporting");
  });
});
