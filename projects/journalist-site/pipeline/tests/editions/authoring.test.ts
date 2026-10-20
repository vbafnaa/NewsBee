import { describe, expect, it } from "vitest";
import { logger } from "../../core/log";
import { loadSettings } from "../../core/config";
import type { SourceResult } from "../../connectors/types";
import { authorNextStory, finishAuthoring, emailContent, latestPublished, shortlistSource, startAuthoring, VALIDATION_POLICY } from "../../editions/authoring";
import { restore, withdraw } from "../../editorial/withdrawals";
import type { SourceEvent } from "../../editions/stories";
import { FakeModel } from "../support/fake-model";
import { withMongo } from "../support/mongo";

function contractValid(value: any): boolean {
  const required = ["id", "location_id", "location_name", "window_start", "window_end", "published_at", "headline", "intro", "items"];
  const itemRequired = ["headline", "blurb", "when_where", "event_date", "source_url"];
  const kinds = new Set(["event", "meeting_preview", "meeting_outcome", "state_news", "earthquake", "trending_topic", "social_trend"]);
  const itemsValid = Array.isArray(value.items) && value.items.every((item: any) => itemRequired.every((key) => key in item)
    && (item.story_id === null || typeof item.story_id === "string") && typeof item.headline === "string" && typeof item.blurb === "string"
    && typeof item.when_where === "string" && typeof item.event_date === "string" && (item.source_url === null || typeof item.source_url === "string")
    && (item.rank === null || Number.isInteger(item.rank)) && kinds.has(item.kind) && typeof item.source_name === "string"
    && (item.section === null || typeof item.section === "string") && typeof item.local === "boolean");
  const coverageValid = ! ("coverage" in value) || (Array.isArray(value.coverage) && value.coverage.every((line: unknown) => typeof line === "string"));
  const correctionsValid = ! ("corrections" in value) || (Array.isArray(value.corrections) && value.corrections.every((item: any) => typeof item.story_id === "string" && typeof item.reason === "string" && typeof item.created_at === "number"));
  return required.every((key) => key in value) && typeof value.id === "string" && typeof value.location_id === "string" && typeof value.location_name === "string"
    && typeof value.window_start === "string" && typeof value.window_end === "string" && typeof value.published_at === "number"
    && typeof value.headline === "string" && typeof value.intro === "string" && itemsValid && coverageValid && correctionsValid;
}
function createEvents(): SourceEvent[] {
  return [
    ["library:main", "Held Event", "2026-11-01"],
    ["meetings:board", "Board Discussion", "2026-11-02"],
    ["hazards:state", "Road Advisory", "2026-11-03"],
  ].map(([source_id, title, event_date], index) => ({ source_id, facts: { source_event_id: `event-${index}`, title, event_date, schedule_text: `November ${index + 1}, 2026`, venue: "Town Hall", room: null, source_url: `https://example.org/story/${index}`, description: "Neighbors discuss practical local resources.", kind: "event", tier: "local", section: null } }));
}

describe("resumable edition authoring", () => {
  const mongo = withMongo();
  it("shortlists per connector type, writes one candidate per step, and publishes a valid contract with holds", async () => {
    const events = createEvents();
    expect(shortlistSource(events.filter((event) => event.source_id.startsWith("library:")), "library").summary.shortlisted).toBe(1);
    let badDrafts = 0;
    const model = new FakeModel(({ prompt }) => {
      if (prompt.startsWith("Rate each candidate")) {
        const data = JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string }>;
        return { ratings: data.map(({ id }) => ({ id, category: "civic_and_practical", civic: 1, appeal: 0, special: 0 })) };
      }
      if (prompt.startsWith("You write for a friendly local community newsletter.")) {
        const storyData = JSON.parse(prompt.match(/\nStory:\n(\{[^\n]*\})/)?.[1] ?? "{}") as { title: string };
        return { headline: `${storyData.title} brings neighbors together`, summary: storyData.title === "Held Event" && badDrafts++ < 2 ? "Free raffle." : "Neighbors discuss practical local resources." };
      }
      if (prompt.startsWith("You edit a friendly local community newsletter.")) {
        const context = JSON.parse(prompt.slice(prompt.lastIndexOf("\nEdition:\n") + "\nEdition:\n".length)) as { stories: Array<{ title: string }> };
        return { headline: `${context.stories[0].title} takes center stage`, intro: "Neighbors can explore these community stories." };
      }
      if (prompt.startsWith("You write the email")) return { blurb: "Discover the latest local community stories." };
      throw new Error(`Unexpected prompt: ${prompt.slice(0, 40)}`);
    });
    const deps = { db: mongo.db, model, settings: loadSettings({ NEWSBEE_ROOT: "C:\\newsbee-test" } as unknown as NodeJS.ProcessEnv), log: logger("test", {}) };
    const sources: SourceResult[] = ["library:main", "meetings:board", "hazards:state"].map((source_id) => ({ source_id, name: source_id, website: null, status: "ingested", detail: "ok", feed_kind: null, feed_url: null, pages_checked: [], response_sha256: null, event_count: 1, skipped_other_venues: 0, skipped_outside_window: 0, skipped_unusable: {}, unmatched_venues: {} }));
    const id = await startAuthoring(deps, { location: { id: "town-1", name: "Auburn, WA" }, runId: "run-1", today: "2026-10-19", window: ["2026-11-01", "2026-11-07"], events, sourceResults: sources });
    expect(id).toBe("run-1");
    let calls = 0;
    let step = await authorNextStory(deps, id);
    while (step.more && calls++ < 10) step = await authorNextStory(deps, id);
    expect(calls).toBeLessThan(10);
    expect(step.done).toBe(true);
    const result = await finishAuthoring(deps, id);
    if (!("edition" in result) || !result.edition || !("summary" in result) || !result.summary || !("emailPreview" in result) || !result.emailPreview) throw new Error("Authoring did not publish");
    expect(contractValid(result.edition)).toBe(true);
    expect(result.edition.items).toHaveLength(2);
    expect(result.summary).toMatchObject({ held: 1, included: 2, attempted: 3, policy: VALIDATION_POLICY });

    expect(result.summary.held_reasons).toHaveProperty("summary:unsupported_claim_word:free");
    expect(result.emailPreview.text).toContain("Read the full Auburn, WA edition");
    expect(await finishAuthoring(deps, id)).toMatchObject({ edition: result.edition });
  });

  it("prioritizes uncovered source types and respects wider inclusion and attempt caps", async () => {
    const events: SourceEvent[] = [
      ["library:main", "Library one", "2026-11-01", "event"],
      ["library:main", "Library two", "2026-11-02", "event"],
      ["meetings:board", "Board meeting", "2026-11-03", "meeting_preview"],
      ["statenews:wa", "County alert", "2026-10-28", "state_news", "region"],
      ["statenews:wa", "County ferry", "2026-10-29", "state_news", "region"],
      ["statenews:wa", "Regional update", "2026-10-30", "state_news", "region"],
      ["statenews:wa", "Regional roads", "2026-10-31", "state_news", "region"],
      ["statenews:wa", "Nearby alert", "2026-11-01", "state_news", "nearby"],
      ["statenews:wa", "Nearby overflow", "2026-11-02", "state_news", "nearby"],
    ].map(([source_id, title, event_date, kind, tier], index) => ({ source_id, facts: { source_event_id: `extra-${index}`, title, event_date, schedule_text: "November 1, 2026", venue: "Town Hall", room: null, source_url: `https://example.org/extra/${index}`, description: "Neighbors discuss practical local resources.", kind, tier: tier ?? "local", section: tier === "region" ? "Around the county" : tier === "nearby" ? "Near town" : null } }));
    const writingOrder: string[] = [];
    const model = new FakeModel(({ prompt }) => {
      if (prompt.startsWith("Rate each candidate")) {
        const candidates = JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string; title: string }>;
        return { ratings: candidates.map(({ id, title }) => ({ id, category: "other", civic: title === "Library one" ? 3 : title === "Library two" ? 2 : 1, appeal: 0, special: 0 })) };
      }
      if (prompt.startsWith("You write for a friendly local community newsletter.")) {
        const item = JSON.parse(prompt.match(/\nStory:\n(\{[^\n]*\})/)?.[1] ?? "{}") as { title: string };
        writingOrder.push(item.title);
        return { headline: `${item.title} brings neighbors together`, summary: "Neighbors discuss practical local resources." };
      }
      if (prompt.startsWith("You edit a friendly local community newsletter.")) return { headline: "Library one leads the edition", intro: "Neighbors can explore the week ahead." };
      return { blurb: "Discover the latest local community stories." };
    });
    const deps = { db: mongo.db, model, settings: loadSettings({ NEWSBEE_ROOT: "C:\\newsbee-test" } as unknown as NodeJS.ProcessEnv), log: logger("test", {}) };
    const sourceIds = [...new Set(events.map((event) => event.source_id))];
    const sourceResults: SourceResult[] = sourceIds.map((source_id) => ({ source_id, name: source_id, website: null, status: "ingested", detail: "ok", feed_kind: null, feed_url: null, pages_checked: [], response_sha256: null, event_count: 1, skipped_other_venues: 0, skipped_outside_window: 0, skipped_unusable: {}, unmatched_venues: {} }));
    const id = await startAuthoring(deps, { location: { id: "town", name: "Auburn, WA" }, runId: "coverage-run", today: "2026-10-19", window: ["2026-11-01", "2026-11-07"], events, sourceResults });
    let step = await authorNextStory(deps, id);
    let safety = 0;
    while (step.more && safety++ < 20) step = await authorNextStory(deps, id);
    const output = await finishAuthoring(deps, id);
    if (!("edition" in output) || !output.edition || !("summary" in output) || !output.summary) throw new Error("Edition was not published");
    expect(writingOrder.slice(0, 3)).toEqual(["Library one", "Board meeting", "Library two"]);
    expect(output.summary).toMatchObject({ local_included: 3, wider_included: 4, wider_attempted: 4, attempted: 7 });
    expect(output.edition.items.slice(0, 3).every((item: any) => item.local)).toBe(true);
    expect(output.edition.items.slice(3).every((item: any) => !item.local)).toBe(true);
    expect(output.edition.items[3].section).toBe("Around the county");
  });

  it("reuses checked story prose by evidence, model and validation policy", async () => {
    const event = createEvents()[1];
    let writes = 0;
    const model = new FakeModel(({ prompt }) => {
      if (prompt.startsWith("Rate each candidate")) {
        const candidates = JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string }>;
        return { ratings: candidates.map(({ id }) => ({ id, category: "other", civic: 1, appeal: 0, special: 0 })) };
      }
      if (prompt.startsWith("You write for a friendly local community newsletter.")) {
        writes += 1;
        const item = JSON.parse(prompt.match(/\nStory:\n(\{[^\n]*\})/)?.[1] ?? "{}") as { title: string };
        return { headline: `${item.title} brings neighbors together`, summary: "Neighbors discuss practical local resources." };
      }
      if (prompt.startsWith("You edit a friendly local community newsletter.")) return { headline: "Board Discussion leads the edition", intro: "Neighbors can explore this community story." };
      return { blurb: "Discover the latest local community story." };
    });
    const deps = { db: mongo.db, model, settings: loadSettings({ NEWSBEE_ROOT: "C:\\newsbee-test" } as unknown as NodeJS.ProcessEnv), log: logger("test", {}) };
    for (const runId of ["cache-one", "cache-two"]) {
      const id = await startAuthoring(deps, { location: { id: "town", name: "Auburn, WA" }, runId, today: "2026-10-19", window: ["2026-11-01", "2026-11-07"], events: [event], sourceResults: [] });
      let step = await authorNextStory(deps, id);
      while (step.more) step = await authorNextStory(deps, id);
      await finishAuthoring(deps, id);
    }
    const cached = await mongo.db.collection("edition_entries").findOne({ edition_id: "cache-two" });
    expect(cached?.result.cache_hit).toBe(true);
  });

  it("applies active withdrawals to the published reader view and restores them", async () => {
    const event = createEvents()[1];
    const model = new FakeModel(({ prompt }) => {
      if (prompt.startsWith("Rate each candidate")) {
        const candidates = JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string }>;
        return { ratings: candidates.map(({ id }) => ({ id, category: "other", civic: 1, appeal: 0, special: 0 })) };
      }
      if (prompt.startsWith("You write for a friendly local community newsletter.")) return { headline: "Board Discussion brings neighbors together", summary: "Neighbors discuss practical local resources." };
      if (prompt.startsWith("You edit a friendly local community newsletter.")) return { headline: "Board Discussion leads the edition", intro: "Neighbors can explore this community story." };
      return { blurb: "Discover the latest local community story." };
    });
    const deps = { db: mongo.db, model, settings: loadSettings({ NEWSBEE_ROOT: "C:\\newsbee-test" } as unknown as NodeJS.ProcessEnv), log: logger("test", {}) };
    const id = await startAuthoring(deps, { location: { id: "town", name: "Auburn, WA" }, runId: "withdraw-run", today: "2026-10-19", window: ["2026-11-01", "2026-11-07"], events: [event], sourceResults: [] });
    let step = await authorNextStory(deps, id);
    while (step.more) step = await authorNextStory(deps, id);
    await finishAuthoring(deps, id);
    const [item] = (await latestPublished(deps, "town"))!.items;
    await withdraw(mongo.db, id, String(item.story_id), "The source corrected this published listing.");
    expect((await latestPublished(deps, "town"))!.items).toEqual([]);
    expect((await latestPublished(deps, "town"))!.corrections).toHaveLength(1);
    expect((await emailContent(deps, id)).intro).toContain("This edition has been corrected");
    await restore(mongo.db, "town", String(item.story_id));
    expect((await latestPublished(deps, "town"))!.items).toHaveLength(1);
  });


  it("caps local and wider attempts independently", async () => {
    async function run(events: SourceEvent[], runId: string) {
      const model = new FakeModel(({ prompt }) => {
        if (prompt.startsWith("Rate each candidate")) {
          const candidates = JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string }>;
          return { ratings: candidates.map(({ id }) => ({ id, category: "other", civic: 0, appeal: 0, special: 0 })) };
        }
        if (prompt.startsWith("You write for a friendly local community newsletter.")) {
          const item = JSON.parse(prompt.match(/\nStory:\n(\{[^\n]*\})/)?.[1] ?? "{}") as { title: string };
          return { headline: `${item.title} welcomes neighbors`, summary: "Free raffle." };
        }
        throw new Error("Empty editions use fixed front and email text");
      });
      const deps = { db: mongo.db, model, settings: loadSettings({ NEWSBEE_ROOT: "C:\\newsbee-test" } as unknown as NodeJS.ProcessEnv), log: logger("test", {}) };
      const id = await startAuthoring(deps, { location: { id: "limits-town", name: "Auburn, WA" }, runId, today: "2026-10-19", window: ["2026-11-01", "2026-11-07"], events, sourceResults: [] });
      let step = await authorNextStory(deps, id);
      let guard = 0;
      while (step.more && guard++ < 24) step = await authorNextStory(deps, id);
      return finishAuthoring(deps, id);
    }
    const localEvents: SourceEvent[] = Array.from({ length: 15 }, (_, index) => ({
      source_id: ["library:main", "meetings:board", "calendar:town"][index % 3],
      facts: { source_event_id: `local-${index}`, title: `Local item ${index}`, event_date: `2026-11-${String(1 + index % 7).padStart(2, "0")}`, schedule_text: "November 1, 2026", venue: "Town Hall", room: null, source_url: `https://example.org/local/${index}`, description: "Neighbors share practical local resources.", kind: "event", tier: "local" },
    }));
    const local = await run(localEvents, "local-cap");
    expect(local.summary).toMatchObject({ attempted: 12, held: 12, included: 0, not_attempted: 3 });
    const kinds = ["earthquake", "state_news", "trending_topic"];
    const sourceIds = ["hazards:usgs", "statenews:wa", "trending:google"];
    const wideEvents: SourceEvent[] = Array.from({ length: 7 }, (_, index) => ({
      source_id: sourceIds[index % sourceIds.length],
      facts: { source_event_id: `wide-${index}`, title: `Wide item ${index}`, event_date: "2026-10-30", schedule_text: "October 30, 2026", venue: "Official source", room: null, source_url: `https://example.org/wide/${index}`, description: "Official sources report practical local resources.", kind: kinds[index % kinds.length], tier: "region", signals: { magnitude: 2, distance_km: 4, ratio: 1 } },
    }));
    const wide = await run(wideEvents, "wide-cap");
    expect(wide.summary).toMatchObject({ attempted: 6, held: 6, included: 0, not_attempted: 1, wider_attempted: 6 });
  });

});
