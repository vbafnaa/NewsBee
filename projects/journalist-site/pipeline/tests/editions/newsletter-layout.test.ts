import { describe, expect, it } from "vitest";
import { newsletterSections } from "../../../../../shared/newsletter-layout";

const item = (id: string, kind: string, rank: number, local = true) => ({ id, kind, rank, local });

describe("newsletter sections shared by publisher and reader", () => {
  it("keeps lower-ranked news ahead of events, local news first and each item exactly once", () => {
    const items = [item("event", "event", 1), item("county", "state_news", 2, false), item("meeting", "meeting_preview", 3),
      item("local", "meeting_outcome", 8), item("quake", "earthquake", 9), item("trend", "social_trend", 10, false)];
    const { news, upcoming } = newsletterSections(items);
    expect(news.map(({ id }) => id)).toEqual(["local", "quake", "county", "trend"]);
    expect(upcoming.map(({ id }) => id)).toEqual(["event", "meeting"]);
    expect(new Set([...news, ...upcoming].map(({ id }) => id)).size).toBe(items.length);
    expect(items[0].id).toBe("event");
  });
  it("supports old payloads without section fields, null ranks and event-only/news-only/empty editions", () => {
    const event = { id: "e", kind: "event", rank: null };
    expect(newsletterSections([event])).toEqual({ news: [], upcoming: [event] });
    const news = item("n", "state_news", 1);
    expect(newsletterSections([news])).toEqual({ news: [news], upcoming: [] });
    expect(newsletterSections([])).toEqual({ news: [], upcoming: [] });
  });
});
