import { describe, expect, it } from "vitest";
import { topicOf } from "../../../../../shared/topics";

const news = (title: string, description = "") => topicOf({ kind: "state_news", title, description });

describe("reader topics", () => {
  it("files real Ballard headlines under the right section", () => {
    expect(news("Sound Transit reassures locals that Ballard light rail will become a reality by 2042")).toBe("transit");
    expect(news("Seattle to install hundreds of new curbside EV chargers")).toBe("transit");
    expect(news("Andalucia closes after nine months in Ballard")).toBe("business");
    expect(news("Egyptian restaurant Cairo opens Oct. 3 in Ballard")).toBe("business");
    expect(news("Seattle City Council approves vehicle resident legislation")).toBe("policy");
    expect(news("92 undelivered ballots found in Golden Gardens dumpster")).toBe("policy");
    expect(news("Ballard Tool Library wins $1,250 grant")).toBe("community");
    expect(news("Seattle Public Schools board votes to close Whittier Elementary")).toBe("schools");
    expect(news("Ballard High School students launch food drive")).toBe("schools");
    expect(news("Julefest returns to National Nordic Museum next month")).toBe("culture");
    expect(news("78-year-old Loyal Heights church to be demolished, land subdivided")).toBe("housing");
    expect(news("Ballard housing market, September 2026: What 24 closed sales say")).toBe("housing");
  });

  it("uses the source's own topic for permits, licences and meeting outcomes", () => {
    expect(topicOf({ kind: "development", title: "Permit issued for new construction in Ballard" })).toBe("housing");
    expect(topicOf({ kind: "business_opening", title: "Ballard Pickleball Club applies for snack bar licence" })).toBe("business");
    expect(topicOf({ kind: "meeting_outcome", title: "Parks board votes on playfield" })).toBe("policy");
    expect(topicOf({ kind: "school_sports", title: "Ballard beats Roosevelt 21-14" })).toBe("sports");
  });

  it("gives no topic to listings, alerts and stories that match nothing", () => {
    expect(topicOf({ kind: "event", title: "Ballard Halloween Carnival" })).toBeNull();
    expect(topicOf({ kind: "weather_alert", title: "Wind advisory for Seattle" })).toBeNull();
    expect(news("Weekly Ballard events calendar Oct. 20 – 25")).toBeNull();
    expect(news("Derelict ship Albert faces removal from Ballard pier")).toBeNull();
  });

  it("matches whole words only", () => {
    expect(news("Barbara's garden tour", "A stroll through barbers' gardens")).toBeNull();
  });

  it("supports the current pipeline's news, record and safety kinds", () => {
    expect(topicOf({ kind: "news_report", title: "Light rail service changes" })).toBe("transit");
    expect(topicOf({ kind: "public_record", title: "Apartment construction permit issued" })).toBe("housing");
    expect(topicOf({ kind: "safety_incident", title: "Burglary at a business" })).toBeNull();
  });
});
