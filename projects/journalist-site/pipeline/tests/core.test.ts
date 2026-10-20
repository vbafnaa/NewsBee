import { describe, expect, it } from "vitest";
import { addDays, httpsLink, plainText, scheduleText } from "../connectors/common";
import { Fetcher, DiscoveryBlockedError } from "../connectors/fetcher";
import { ReplayTransport } from "./support/replay";
import { withMongo } from "./support/mongo";

describe("common (port of connectors/common.py)", () => {
  it("turns HTML into single-spaced sentences", () => {
    expect(plainText("<p>Story time</p><p>Ages 3&ndash;5</p>")).toBe("Story time. Ages 3\u20135.");
    expect(plainText("&lt;b&gt;Bold&lt;/b&gt; text")).toBe("Bold text.");
    expect(plainText("")).toBeNull();
  });

  it("cuts long text at a word boundary", () => {
    expect(plainText("alpha beta gamma delta", 12)).toBe("alpha beta...");
  });

  it("formats schedules in the source's local time", () => {
    expect(scheduleText({ year: 2026, month: 10, day: 20, hour: 10, minute: 30 }, { year: 2026, month: 10, day: 20, hour: 11 }))
      .toBe("Tuesday, October 20, 2026, 10:30am \u2013 11am");
    expect(scheduleText({ year: 2026, month: 10, day: 20 })).toBe("Tuesday, October 20, 2026");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("accepts only https links without credentials", () => {
    expect(httpsLink("https://example.org/a")).toBe("https://example.org/a");
    expect(httpsLink("http://example.org")).toBeNull();
    expect(httpsLink("https://user:pw@example.org")).toBeNull();
  });
});

describe("Fetcher", () => {
  it("follows vetted redirects and honours robots.txt", async () => {
    const replay = new ReplayTransport()
      .on("https://a.example/robots.txt", { body: "User-agent: *\nDisallow: /private" })
      .on("https://a.example/start", { status: 302, headers: { Location: "/end" } })
      .on("https://a.example/end", { body: "done" });
    const fetcher = new Fetcher(replay.transport);
    const [url, body] = await fetcher.getText("https://a.example/start", 1024, "text/html");
    expect(url).toBe("https://a.example/end");
    expect(body).toBe("done");
    await expect(fetcher.get("https://a.example/private/x", 1024, "*/*")).rejects.toBeInstanceOf(DiscoveryBlockedError);
  });
});

describe("mongo test harness", () => {
  const mongo = withMongo();
  it("gives each test a fresh database", async () => {
    await mongo.db.collection("x").insertOne({ a: 1 });
    expect(await mongo.db.collection("x").countDocuments()).toBe(1);
  });
});
