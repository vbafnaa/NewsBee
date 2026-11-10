import { expect, it } from "vitest";
import { collapse, whenWhere, type SourceEvent } from "../../editions/stories";

function event(source: string, overrides: Record<string, unknown> = {}): SourceEvent {
  return { source_id: source, facts: { source_event_id: source, title: "Garden meeting", description: "The garden meeting is planned.", event_date: "2026-11-10", schedule_text: "November 10", venue: "Town Hall", room: null, source_url: `https://${source}.example/news`, kind: "event", ...overrides } };
}
it("counts duplicate source copies once for recurrence and reader schedules without losing provenance", () => {
  const story = collapse([event("official"), event("repost")])[0];
  expect(story.occurrences).toHaveLength(2);
  expect(story.scheduledOccurrences).toHaveLength(1);
  expect(story.recurring).toBe(false);
  expect(whenWhere(story)).toBe("When: November 10. Where: Town Hall.");
});
it("keeps distinct scheduled sessions", () => {
  const story = collapse([event("official"), event("later", { event_date: "2026-11-17", schedule_text: "November 17" })])[0];
  expect(story.recurring).toBe(true);
  expect(whenWhere(story)).toContain("November 17");
});
it.each([false, true])("preserves the selected primary source even when the secondary copy is longer or earlier (reversed=%s)", (reverse) => {
  const lead = event("official", { lead: true, merge_group: "same-news", kind: "local_news", title: "Garden proposal", description: "The garden is proposed; no vote has taken place." });
  const secondary = event("repost", { merge_group: "same-news", kind: "local_news", event_date: "2026-11-09", description: "The garden has been approved, according to an unverified secondary report with a much longer description." });
  const story = collapse(reverse ? [secondary, lead] : [lead, secondary])[0];
  expect(story.title).toBe(lead.facts.title);
  expect(story.description).toBe(lead.facts.description);
  expect(story.first.source_url).toBe(lead.facts.source_url);
  expect(story.facts).toBe(lead.facts);
  expect(story.occurrences).toHaveLength(2);
});
