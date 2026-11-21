import { describe, expect, it } from "vitest";
import { sectionFor, summaryLede } from "../../sourcemap/sections";

// A long article body: the opening sentences, then a passing mention far below.
const body = (opening: string, later: string) => `${opening} ${"The rest of the article describes the work in detail. ".repeat(8)}${later}`;

describe("section keywords (real misfiled stories from Wedgwood and Seattle runs)", () => {
  it("files by the headline before any word in the summary", () => {
    expect(sectionFor({ kind: "news_report", title: "Ticket Alert: Liquid Stranger, The Chats, and More Seattle Events Going On Sale", description: "Plus, an election-night watch party." })).toBe("events");
    expect(sectionFor({ kind: "news_report", title: "Councilmember Rob Saka Backs Katie Wilson's RV Ban Veto", description: "The veto concerns a permit for vehicle residents." })).toBe("civic");
    expect(sectionFor({ kind: "local_news", title: "Wedgwood Business District Trick-or-Treat, Saturday, October 31st, 4-6PM", description: "Kids and families can visit participating shops." })).toBe("business");
  });

  it("ignores a passing word deep in a long summary", () => {
    expect(sectionFor({ kind: "news_report", title: "Japanese Butoh group Sankai Juku to bring their powerful presence in movement and dance",
      description: body("Butoh group Sankai Juku will perform at Seattle's Moore Theatre on November 17.", "Its founder passed away in 2019.") })).not.toBe("obituaries");
    expect(sectionFor({ kind: "news_report", title: "We ain't your expectation",
      description: body("Travis Yee, an Asian American country singer, sings about expectations.", "He recalls an arrest at a protest.") })).not.toBe("safety");
    expect(sectionFor({ kind: "news_report", title: "I Saw U: Eating Taco Bell at Linda's, Riding the Vashon Ferry",
      description: body("Readers share their missed connections from around town.", "One mentions the first snow.") })).not.toBe("weather");
  });

  it("still files on clear evidence at the top of the summary", () => {
    expect(sectionFor({ kind: "local_news", title: "Saturday – October 31, 2026", description: "Police arrested a suspect after a shooting near the park." })).toBe("safety");
    expect(sectionFor({ kind: "local_news", title: "Jane Doe, 1931–2026", description: "Jane Doe passed away peacefully at home." })).toBe("obituaries");
  });

  it("recognises game recaps as sports", () => {
    expect(sectionFor({ kind: "news_report", title: "Lincoln Stuns Franklin 24-20 In Regular Season Finale", description: "A homecoming crowd watched the high school game." })).toBe("sports");
    expect(sectionFor({ kind: "news_report", title: "Roosevelt beats Ballard 3-1 at Memorial Stadium" })).toBe("sports");
  });

  it("keeps whole sentences in the lede and stays bounded", () => {
    expect(summaryLede("One. Two.")).toBe("One. Two.");
    expect(summaryLede(null)).toBe("");
    expect(summaryLede("x".repeat(5000)).length).toBeLessThanOrEqual(700);
  });
});
