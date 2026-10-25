import { describe, expect, it } from "vitest";
import { mergeListings, minutesOf, publishedCalendar, sourceListings } from "../../editions/calendar";
import type { SourceEvent } from "../../editions/stories";
import { calendarDays, sectionOf } from "../../../../../shared/newsletter-layout";

const window: [string, string] = ["2026-10-26", "2026-11-01"];
const event = (id: string, overrides: Record<string, unknown> = {}): SourceEvent => ({
  source_id: "library:spl",
  facts: {
    source_event_id: id, title: `Story time ${id}`, event_date: "2026-10-27", schedule_text: "Tue, Oct 27, 10:30 AM",
    venue: "Ballard Branch", source_url: `https://spl.example/events/${id}`, description: "Songs and stories.", kind: "event",
    ...overrides,
  },
});

describe("calendar listings", () => {
  it("lists every eligible upcoming item with no story cap", () => {
    const events = Array.from({ length: 30 }, (_, index) => event(`e${index}`));
    expect(sourceListings(events, "Seattle Public Library", window)).toHaveLength(30);
  });

  it("applies the same deterministic checks as stories", () => {
    const listings = sourceListings([
      event("ok"),
      event("news", { kind: "state_news" }),
      event("cancelled", { title: "CANCELLED: Story time" }),
      event("http", { source_url: "http://spl.example/x" }),
      event("before", { event_date: "2026-10-25" }),
      event("after", { event_date: "2026-11-02" }),
      event("sensitive", { title: "Hearing for the suspect" }),
      event("nearby", { tier: "nearby" }),
      event("meeting", { kind: "meeting_preview", title: "Parks committee" }),
    ], "Source", window);
    expect(listings.map((item) => item.source_event_id).sort()).toEqual(["meeting", "ok"]);
    expect(listings.find((item) => item.source_event_id === "ok")).toMatchObject({ title: "Story time ok", source_name: "Source", kind: "event" });
  });

  it("orders by day then time, with untimed listings first", () => {
    expect(minutesOf("Tue, Oct 27, 1:15 PM")).toBe(795);
    expect(minutesOf("12 a.m.")).toBe(0);
    expect(minutesOf("All day")).toBe(-1);
    const listings = sourceListings([
      event("late", { schedule_text: "Tue, Oct 27, 6 PM" }),
      event("next", { event_date: "2026-10-28" }),
      event("allday", { schedule_text: "Tue, Oct 27" }),
    ], "Source", window);
    expect(listings.map((item) => item.source_event_id)).toEqual(["allday", "late", "next"]);
  });

  it("collapses the same listing from two sources and caps the total", () => {
    const first = sourceListings([event("a")], "Library", window);
    const second = sourceListings([{ ...event("a"), source_id: "civiccalendar:seattle" }], "City", window);
    expect(mergeListings([...first, ...second])).toHaveLength(1);
    const many = sourceListings(Array.from({ length: 10 }, (_, index) => event(`m${index}`)), "Library", window);
    expect(mergeListings(many, 4)).toHaveLength(4);
  });

  it("publishes without past or withdrawn listings or internal references", () => {
    const listings = sourceListings([event("past", { event_date: "2026-10-26" }), event("keep"), event("gone")], "Library", window);
    const decisions = { s1: { location_id: "ballard", story_id: "s1", reason: "Withdrawn by editor.", created_at: 1, source_refs: [["library:spl", "gone"]] as [string, string][] } };
    const published = publishedCalendar(listings, "2026-10-27", decisions);
    expect(published.map((item) => item.title)).toEqual(["Story time keep"]);
    expect(published[0]).not.toHaveProperty("source_id");
  });
});

describe("reader sections", () => {
  it("maps every story kind to a tab", () => {
    expect(sectionOf("event")).toBe("events");
    expect(sectionOf("meeting_outcome")).toBe("council");
    expect(sectionOf("school_sports")).toBe("schools");
    expect(sectionOf("safety_notice")).toBe("safety");
    expect(sectionOf("development")).toBe("development");
    expect(sectionOf("state_news")).toBe("news");
    expect(sectionOf(undefined)).toBe("events");
  });

  it("groups listings by day in date order", () => {
    const [a, b] = sourceListings([event("b", { event_date: "2026-10-28" }), event("a")], "Library", window);
    expect(calendarDays([a, b]).map((day) => [day.date, day.items.length])).toEqual([["2026-10-27", 1], ["2026-10-28", 1]]);
  });
});
