import { describe, expect, it } from "vitest";
import { addedClaims } from "../../model/news-blurb";
import { itemPrompt, styleErrors, validateItem, writeItem, writeEmail, writeFront, type StoryInput } from "../../model/story-writer";
import { FakeModel } from "../support/fake-model";

const story: StoryInput = { id: "robot-lab", title: "Robot Lab", description: "Build and program small robots with LEGO kits. Ages 8 to 12.", venues: ["Ballard Branch"] };
const draft = (summary: string, headline = "Robot Lab welcomes young builders") => ({ headline, summary });

describe("story writing validation", () => {
  it("does not treat an age at sentence end as a numbered list marker", () => {
    expect(styleErrors("This activity is for ages 19. It welcomes the whole community.")).not.toContain("list_formatting");
  });
  it("flags actual numbered lists", () => {
    expect(styleErrors("1. Build robots. 2. Program them.")).toContain("list_formatting");
  });
  it("does not count common abbreviations as sentence boundaries", () => {
    expect(addedClaims("The U.S. Geological Survey recorded this.", [], 1)).not.toContain("too_many_sentences");
    expect(addedClaims("Dr. Lee spoke at 9 a.m. It was useful.", [], 2)).not.toContain("too_many_sentences");
    expect(addedClaims("The U.S. Geological Survey recorded this. Neighbors should take note.", [], 1)).toContain("too_many_sentences");
  });
  it("validates headline identity, prose, claims, dates and repetitions", () => {
    expect(validateItem(story, draft("Build and program small robots with LEGO kits. Ages 8 to 12 can join in."))).toEqual([]);
    expect(validateItem(story, draft("Build robots. Win a raffle."))).toContain("summary:unsupported_claim_word:raffle");
    expect(validateItem(story, draft("Build robots on Tuesday."))).toContain("summary:repeats_when_where");
    expect(validateItem(story, draft("Build robots. Build robots."))).toContain("summary:repeated_sentence");
    expect(validateItem(story, draft("Build robots.", "Kids have fun"))).toContain("headline:drops_event_name");
  });
  it("retries a rejected draft once with validation feedback", async () => {
    let count = 0;
    const model = new FakeModel(() => ++count === 1 ? draft("Free raffle.") : draft("Build and program small robots with LEGO kits. Ages 8 to 12 can join in."));
    const result = await writeItem(model, story);
    expect(result).toMatchObject({ disposition: "checks_passed", attempts: 2 });
    expect(model.calls[1].prompt).toContain("Your previous draft was rejected");
    expect(model.calls[1].prompt).toContain("summary:unsupported_claim_word:raffle");
  });
  it.each([
    ["Build robots\nwith friends.", "summary:multiple_lines"],
    ["Read more at https://example.org.", "summary:link_or_handle"],
    ["Build robots. They create. Everyone learns. Neighbors share.", "summary:too_many_sentences"],
    ["Build robots. Win a raffle.", "summary:unsupported_claim_word:raffle"],
    ["Build robots on Tuesday.", "summary:repeats_when_where"],
    ["Build robots", "summary:unfinished_sentence"],
    ["- Build robots.", "summary:list_formatting"],
    ["Build robots. Build robots.", "summary:repeated_sentence"],
    ["Robot Lab welcomes young builders. Build robots.", "summary:repeats_headline"],
    ["Build robots.\u7121", "summary:foreign_characters"],
  ])("holds a story validation violation: %s", (summary, error) => {
    expect(validateItem(story, draft(summary))).toContain(error);
  });
  it("keeps news date policy and model prompts aligned", () => {
    const news = { ...story, kind: "state_news" };
    expect(validateItem(news, draft("The U.S. Geological Survey published this on Tuesday.", "Robot Lab publishes news"))).not.toContain("summary:repeats_when_where");
    expect(itemPrompt(story)).toContain("Do not mention days, dates, times or the location");
    expect(itemPrompt({ ...story, title: "Café Robot Lab" })).toContain("Caf\\u00e9 Robot Lab");
  });
  it("retries a held edition front and falls back for held email content", async () => {
    let call = 0;
    const model = new FakeModel(({ prompt }) => {
      if (prompt.startsWith("You edit a friendly local community newsletter.")) {
        call += 1;
        return call === 1 ? { headline: "Fun for the whole town", intro: "Neighbors can explore this event." } : { headline: "Robot Lab welcomes new builders", intro: "Neighbors can explore this event." };
      }
      return { blurb: "Win a free raffle online!" };
    });
    const front = await writeFront(model, "Auburn", "Nov 1–7", [story], [{ headline: "Robot Lab welcomes new builders", summary: "Neighbors discuss robot programming." }]);
    expect(front).toMatchObject({ fallback: false, attempts: 2, headline: "Robot Lab welcomes new builders" });
    expect(model.calls[1].prompt).toContain("drops_event_name");
    const email = await writeEmail(model, "Auburn", "Nov 1–7", [story], [{ headline: "Robot Lab welcomes new builders", summary: "Neighbors discuss robot programming." }], front as { headline: string; intro: string });
    expect(email).toMatchObject({ fallback: true, blurb: "See what is happening around Auburn this week in the new edition." });
  });

});
