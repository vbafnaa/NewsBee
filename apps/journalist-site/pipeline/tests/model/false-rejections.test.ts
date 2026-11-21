import { describe, expect, it } from "vitest";
import { groundingErrors, namedEntityErrors } from "../../model/grounding";
import { readabilityErrors } from "../../model/readability";
import { headlineErrors, repairDraft, requiredDetails, validateItem } from "../../model/story-writer";

// Each case is a real model draft (mistral, November 17 review) that was rejected for a
// reason that was not a factual error, which made the pipeline reprint source text instead.
describe("checks no longer reject good drafts for non-errors", () => {
  it("accepts 'prior' for an accommodation lead time", () => {
    const story = { id: "s", kind: "event", title: "Family Story Time", description: "Registration is not required. Please contact LEAP at least seven days before the event to request accommodations." };
    const [notice] = requiredDetails(story);
    expect(notice.present("LEAP requests accommodation requests at least seven days prior to the event.")).toBe(true);
    expect(notice.present("Contact LEAP to request accommodations.")).toBe(false);
  });

  it("does not treat an ordinary sentence opener as an invented name", () => {
    const source = ["Family Story Time", "Join us at the Northeast Branch on Tuesday for stories and songs."];
    expect(namedEntityErrors("Every Tuesday, families gather at the Northeast Branch.", source)).toEqual([]);
    expect(namedEntityErrors("On Tuesday the Northeast Branch hosts stories.", source)).toEqual([]);
    // A real invented name in the same position is still caught.
    expect(namedEntityErrors("Rainier Library hosts stories on Tuesday.", source)).toContain("unsupported_name:Rainier");
  });

  it("allows the correct spelling of a name the source misspells, but not a different name", () => {
    const source = ["This is a family-friendly event that the Wedgwood Communit Council organizes each year."];
    expect(namedEntityErrors("The Wedgwood Community Council organizes the event.", source)).toEqual([]);
    expect(namedEntityErrors("The Wedgwood Neighborhood Council organizes the event.", source)).toContain("unsupported_name:Neighborhood");
  });

  it("drops a cut-off final sentence and link-only sentences instead of discarding the draft", () => {
    const cut = repairDraft({ headline: "SPS Enrollment Info Session", summary: "The SPS Enrollment Team will explain the enrollment process. The event is one of several in-person and virtual sessions scheduled" });
    expect(cut.draft.summary).toBe("The SPS Enrollment Team will explain the enrollment process.");
    expect(cut.repairs).toContain("removed_unfinished_sentence");
    const links = repairDraft({ headline: "Trick-or-treat", summary: "Kids in costume visit participating businesses (<https://wedgwoodcc.org/halloween>). Volunteers are needed at NE 85th Street. Interested individuals can contact the council at admin@wedgwoodcc.org." });
    expect(links.draft.summary).toBe("Kids in costume visit participating businesses. Volunteers are needed at NE 85th Street.");
    expect(links.repairs).toEqual(expect.arrayContaining(["removed_parenthetical_link", "removed_link_sentence"]));
  });

  it("never repairs a one-sentence draft away or changes a draft that needs no repair", () => {
    expect(repairDraft({ headline: "h", summary: "Only an unfinished sentence" }).draft.summary).toBe("Only an unfinished sentence");
    const clean = { headline: "h", summary: "One. Two." };
    expect(repairDraft(clean)).toEqual({ draft: clean, repairs: [] });
  });

  it("still rejects real errors after repair", () => {
    const story = { id: "s", kind: "event", title: "Genealogy Drop-In", description: "Members of the Seattle Genealogical Society will offer one-on-one help. Registration is not required." };
    const errors = validateItem(story, repairDraft({ headline: "Genealogy Drop-In offers family history help", summary: "Members of the Seattle Genealogical Society offer help for $20. Registration is not required." }).draft);
    expect(errors.some((error) => error.includes("unsupported_number"))).toBe(true);
  });

  it("catches problems that newly passing drafts exposed", () => {
    // Promotional close on the Enrollment draft.
    expect(readabilityErrors({ title: "Enrollment Info Session", kind: "event" }, { headline: "SPS explains school choice enrollment",
      summary: "The SPS Enrollment Team explains the process. For families seeking clarity, this is an opportunity not to be missed." })).toContain("summary:filler_phrase:not to be missed");
    // Headline cut off mid-time on the trick-or-treat draft.
    expect(headlineErrors("Wedgwood Business District Holds Annual Trick-or-Treat Event on Halloween, October 31st, 4")).toContain("incomplete_headline");
    expect(headlineErrors("Lincoln beats Franklin 24-20 in season finale")).toEqual([]);
    expect(headlineErrors("Council adopts budget for 2026")).toEqual([]);
    // Block-level permit location turned into an exact address.
    const source = ["City of Seattle recorded a single family/duplex on Monday, November 2 for the 2700 block of NE 92ND ST: Demolition."];
    expect(groundingErrors("The City of Seattle filed a permit for a demolition at 2700 NE 92nd St.", source)).toContain("unsupported_exact_address");
    expect(groundingErrors("The City of Seattle recorded a demolition on the 2700 block of NE 92nd St.", source)).not.toContain("unsupported_exact_address");
  });

  it("removes a link sentence whole, even when the link contains dots and question marks", () => {
    const { draft } = repairDraft({ headline: "h", summary: "The council meets on Zoom. Join at https://us06web.zoom.us/j/89616933523?pwd=2FbvQAPEzTnRPnYR7LV8bBdOLbwKpY.1. The agenda includes public comment." });
    expect(draft.summary).toBe("The council meets on Zoom. The agenda includes public comment.");
  });

  it("keeps a source range instead of turning it into one exact number", () => {
    const source = ["We are still looking for another 1-2 volunteers to help kids cross safely. Kids visit businesses between 4-6PM."];
    expect(groundingErrors("Two volunteer positions remain open to help kids cross safely.", source)).toContain("unsupported_number_range");
    expect(groundingErrors("The council needs one or two more volunteers.", source)).not.toContain("unsupported_number_range");
    expect(groundingErrors("The council needs 1-2 more volunteers.", source)).not.toContain("unsupported_number_range");
    expect(groundingErrors("The council is still looking for volunteers.", source)).not.toContain("unsupported_number_range");
    expect(groundingErrors("Kids trick-or-treat from 4 to 6 PM.", source)).not.toContain("unsupported_number_range");
  });

  it("accepts spelled-out street types for abbreviated record addresses", () => {
    expect(namedEntityErrors("A demolition was recorded on the 2700 block of NE 92nd Street.", ["Demolition at the 2700 block of NE 92ND ST"])).toEqual([]);
  });

  it("does not let livelier wording turn a recorded permit into work in progress", () => {
    const source = ["City of Seattle recorded a single family/duplex on Monday, November 2 for the 2700 block of NE 92ND ST: Demolition."];
    expect(groundingErrors("Million-Dollar Demolition Project Underway on NE 92nd Street", source)).toContain("unsupported_completion");
    expect(groundingErrors("City records reveal a demolition project in progress on the 2700 block.", source)).toContain("unsupported_completion");
    expect(groundingErrors("Construction is not yet underway.", source)).not.toContain("unsupported_completion");
  });
});
