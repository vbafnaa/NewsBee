import { describe, expect, it } from "vitest";
import { explainReadability, isReadabilityError, readabilityErrors } from "../../model/readability";
import { briefErrors, itemPrompt, validateItem } from "../../model/story-writer";

// Drafts below are from the November 8 real-source review (research/part2_article_review.md).
describe("article readability", () => {
  it("rejects headlines that copy the calendar listing", () => {
    expect(readabilityErrors({ title: "Join us for our November 2026 Board Meeting via Zoom – November 10th", kind: "local_news" },
      { headline: "Join us for our November 2026 Board Meeting via Zoom", summary: "The Wedgwood Community Council meets online." })).toContain("headline:listing_headline:invitation");
    expect(readabilityErrors({ title: "Wedgwood Business District Trick-or-Treat, Saturday, October 31st, 4-6PM", kind: "local_news" },
      { headline: "Wedgwood Business District Trick-or-Treat, Saturday, October 31st, 4-6PM", summary: "Shops on 35th Ave NE hand out treats." }))
      .toEqual(expect.arrayContaining(["headline:listing_headline:clock_time", "headline:listing_headline:copied_title"]));
    expect(readabilityErrors({ title: "Land use event Monday, November 9th", kind: "local_news" },
      { headline: "Land use event Monday, November 9th at Maple Leaf Lutheran Church", summary: "A forum looks at land use." })).toContain("headline:listing_headline:copied_title");
    expect(readabilityErrors({ title: "Genealogy Drop-In", kind: "event" },
      { headline: "Genealogy Drop-In on Thursday at Northeast Branch", summary: "Volunteers help with family history." })).toContain("headline:listing_headline:calendar_date");
  });

  it("allows specific headlines, including dates in news headlines", () => {
    expect(readabilityErrors({ title: "Overnight eastbound I-90 closures slated for Nov. 6", kind: "news_report" },
      { headline: "Eastbound I-90 closes overnight starting Friday", summary: "WSDOT plans overnight closures of eastbound I-90." })).toEqual([]);
    expect(readabilityErrors({ title: "Family Story Time", kind: "event" },
      { headline: "Family Story Time brings songs and stories to Northeast Branch", summary: "Families can share stories and songs with their little ones. The program is free." })).toEqual([]);
  });

  it("flags run-on sentences, filler and event logistics in the prose", () => {
    expect(readabilityErrors({ title: "Family Story Time", description: "Stories, songs and activities for families.", kind: "event" }, { headline: "Family Story Time at Northeast Branch",
      summary: "Families of all ages can enjoy stories, songs, and fun learning activities with their little ones at this free and open program, designed to foster learning and community among young children and their caregivers." })).not.toContain("summary:long_sentence");
    expect(readabilityErrors({ title: "Dahl Field Restroom Renovation Schedule Update", kind: "local_news" }, { headline: "Dahl Field restroom work set for 2027",
      summary: "Seattle Parks updated the schedule for the Dahl Field restroom renovation, which has been closed since a fire, and the city has published procurement documents with the construction bid set to close on November 4th, after which it will review responses from prospective bidders and award the project to a contractor, aiming for construction in winter or spring 2027." })).toContain("summary:long_sentence");
    expect(readabilityErrors({ title: "No School Veterans Day", kind: "event" }, { headline: "No school on Veterans Day",
      summary: "Seattle schools are closed. The event is a meaningful way for the community to come together." }))
      .toEqual(expect.arrayContaining(["summary:filler_phrase:meaningful way", "summary:filler_phrase:come together"]));
    expect(readabilityErrors({ title: "Genealogy Drop-In", kind: "event" }, { headline: "Genealogy Drop-In offers family history help",
      summary: "Volunteers help with research. Contact the library at 206-386-4636 for more information." })).toContain("summary:logistics_in_prose");
    expect(readabilityErrors({ title: "Enrollment Info Session", kind: "event" }, { headline: "Enrollment Info Session explains school choice",
      summary: "Viewlands Elementary, 10525 3rd Ave. NW, Seattle, WA 98177, will host it." })).toContain("summary:logistics_in_prose");
  });

  it("allows filler words the source itself uses, and addresses in news and incidents", () => {
    expect(readabilityErrors({ title: "Neighbours come together for park cleanup", kind: "local_news" },
      { headline: "Neighbours come together for park cleanup", summary: "Volunteers will come together at Dahl Field to pick up litter." })).toEqual([]);
    expect(readabilityErrors({ title: "Building at the 8000 block of 27th Ave NE", kind: "development" },
      { headline: "Window replacement recorded on 27th Ave NE", summary: "The city recorded a permit for 8015 27th Ave NE." })).toEqual([]);
  });

  it("asks for flowing prose and source-only comparisons, and explains failures", () => {
    const prompt = itemPrompt({ id: "x", title: "Family Story Time", kind: "event" });
    expect(prompt).toMatch(/one flowing story/);
    expect(prompt).toMatch(/Make it worth reading/);
    expect(itemPrompt({ id: "y", title: "Court hearing set", kind: "court_case" })).not.toMatch(/Make it worth reading/);
    expect(prompt).toMatch(/never restate a place, date, agency or source/);
    expect(prompt).toMatch(/both come from the source/);
    expect(explainReadability(["summary:long_sentence", "headline:listing_headline:invitation"])).toMatch(/newspaper headline.*Break up run-on sentences.*do not chop/s);
  });

  it("flags sentences that only restate earlier facts (real November 17 drafts)", () => {
    const demolition = "City of Seattle records demolition plan for 2700 block of NE 92ND ST, valued at $1,000,000. The project involves demolishing a residential structure as per the plans. The demolition was recorded on Monday, November 2, by the City of Seattle. The location is the 2700 block of NE 92ND ST.";
    expect(readabilityErrors({ title: "Demolition at the 2700 block of NE 92ND ST", kind: "development" }, { headline: "Demolition recorded on NE 92nd St", summary: demolition })).toContain("summary:restated_fact");
    expect(readabilityErrors({ title: "Enrollment Info Session", kind: "event" }, { headline: "SPS Enrollment Info Session Offers In-Person Guidance",
      summary: "The SPS Enrollment Team hosts community information sessions to explain the enrollment process and School Choice options. Attend to learn about the Open Enrollment timeline and eligibility." })).toEqual([]);
  });

  it("never reprints promotional, first-person or raw-record source text as an article", () => {
    // Real fallbacks from the November 17 run.
    expect(briefErrors("Ghosts, goblins, princesses, and enderman will be over taking 35th Ave NE and patronizing the wonderful businesses for Wedgwood’s annual trick or treat!")).toEqual(expect.arrayContaining(["brief:promotional_source"]));
    expect(briefErrors("Our mission is to propose growth strategies for Seattle.")).toContain("brief:first_person_source");
    expect(briefErrors("City of Seattle recorded a single family/duplex on Monday, November 2 for the 2700 block of NE 92ND ST: Demolition.")).toContain("brief:record_fields");
    expect(briefErrors("Building. Project: Window and door replacement to existing dwelling unit.")).toContain("brief:record_fields");
    expect(briefErrors("At storytime, kids ages 0-5 and their families can enjoy stories, songs, and learning activities. Registration is not required.")).toEqual([]);
  });

  it("runs inside the writer's validation", () => {
    const errors = validateItem({ id: "x", title: "Genealogy Drop-In", description: "Free help. Call 206-386-4636.", kind: "event" },
      { headline: "Join the Genealogy Drop-In", summary: "Free help is available. Call 206-386-4636." });
    expect(errors).toEqual(expect.arrayContaining(["headline:listing_headline:invitation", "summary:logistics_in_prose"]));
    expect(errors.filter(isReadabilityError)).toHaveLength(2);
    expect(isReadabilityError("summary:unsupported_number:5")).toBe(false);
  });
});
