import { describe, expect, it } from "vitest";
import { topicOf, topicOfFiled } from "../../../../../shared/topics";

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

  it("files school athletics under sports, not schools", () => {
    expect(news("Ballard High names new athletic director")).toBe("sports");
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

  it("follows the section a story was filed under, so reader headings match the workspace", () => {
    // Real Wedgwood items whose headline words pointed to a different reader section.
    const dahl = { kind: "local_news", title: "Dahl Field Restroom Renovation Schedule Update", description: "New restroom construction and permit schedule." };
    expect(topicOf(dahl)).toBe("housing");
    expect(topicOfFiled({ ...dahl, section_id: "community" })).toBe("community");
    const cuts = { kind: "local_news", title: "Seattle's Proposed Fire Department Cuts Expose Stretched Emergency Response", description: "The council budget proposal." };
    expect(topicOfFiled({ ...cuts, section_id: "civic" })).toBe("policy");
    expect(topicOfFiled({ kind: "local_news", title: "Lincoln Stuns Franklin 24-20 In Regular Season Finale", section_id: "sports" })).toBe("sports");
    expect(topicOfFiled({ kind: "local_news", title: "Permit filed for townhomes", section_id: "real_estate" })).toBe("housing");
    expect(topicOfFiled({ kind: "meeting_outcome", title: "Board votes", section_id: "civic" })).toBe("policy");
  });

  it("keeps keyword topics for general sections and editions published before sections were saved", () => {
    const bus = { kind: "news_report", title: "Light rail service changes" };
    expect(topicOfFiled(bus)).toBe("transit");
    expect(topicOfFiled({ ...bus, section_id: "news" })).toBe("transit");
    expect(topicOfFiled({ ...bus, section_id: null })).toBe("transit");
    expect(topicOfFiled({ kind: "local_news", title: "Gallery opens new mural exhibit", section_id: "events" })).toBe("culture");
    // Real items the pipeline's keywords misfiled as milestones or safety keep their reader topic.
    expect(topicOfFiled({ kind: "news_report", title: "Japanese Butoh group Sankai Juku to bring their powerful presence in movement and dance to the Moore Theatre", section_id: "obituaries" })).toBe("culture");
    expect(topicOfFiled({ kind: "news_report", title: "Cascadia Art Museum celebrates Zoe Dusanne, who collected and championed Japanese art", section_id: "obituaries" })).toBe("culture");
    // Courts, incidents and obituaries never join a topic section, whatever their filing.
    expect(topicOfFiled({ kind: "court_case", title: "Council member's case continues", section_id: "civic" })).toBeNull();
  });
});
