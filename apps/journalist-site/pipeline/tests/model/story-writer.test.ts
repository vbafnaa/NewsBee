import { describe, expect, it } from "vitest";
import { addedClaims } from "../../model/news-blurb";
import { headlineErrors, itemPrompt, styleErrors, validateFront, validateEmail, editionContext, validateItem, writeItem, writeEmail, writeFront, type StoryInput } from "../../model/story-writer";
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
    expect(validateItem(story, draft("Build robots on Tuesday."))).toContain("summary:unsupported_date_word:tuesday");
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
    ["The new program introduces robot building.", "unsupported_novelty"],
    ["A moderated discussion explores robot designs.", "unsupported_moderation"],
    ["Organizers say builders will learn together.", "unsupported_attribution"],
    ["Activities support developmental milestones.", "unsupported_developmental_claim"],
    ["The bilingual session explores robot building.", "unsupported_language_claim"],
  ])("holds unsupported editorial additions and allows explicit evidence: %s", async (text, reason) => {
    expect(validateItem(story, draft(text))).toContain(`summary:${reason}`);
    expect(validateItem({ ...story, description: `${story.description} ${text}` }, draft(text))).not.toContain(`summary:${reason}`);
    const model = new FakeModel(() => draft(text));
    expect(await writeItem(model, story)).toMatchObject({ disposition: "held", attempts: 2, validation_errors: expect.arrayContaining([`summary:${reason}`]) });
    expect(model.calls[1].prompt).toContain("Remove the unsupported novelty");
  });
  it("checks front and email assertions against original facts, not previous model text", async () => {
    const drafts = [draft("Build small robots.")];
    const context = editionContext("Auburn", "Oct 20-26", [story], drafts);
    expect(validateFront(context, [story], { headline: "Robot Lab launches a new program", intro: "A moderated discussion explores robot designs." })).toEqual(expect.arrayContaining(["headline:unsupported_novelty", "intro:unsupported_moderation"]));
    const corrected = new FakeModel(({ prompt }) => prompt.includes("previous draft") ? draft("Build small robots with LEGO kits.") : draft("Organizers say everyone will learn together."));
    expect(await writeItem(corrected, story)).toMatchObject({ disposition: "checks_passed", attempts: 2 });
    const email = await writeEmail(new FakeModel(() => ({ blurb: "Organizers say young builders will explore robot designs." })), "Auburn", "Oct 20-26", [story], drafts,
      { headline: "Robot Lab welcomes builders", intro: "Explore robot designs." });
    expect(email).toMatchObject({ fallback: true, validation_errors: expect.arrayContaining(["blurb:unsupported_attribution"]) });
  });
  it.each([
    ["Build robots\nwith friends.", "summary:multiple_lines"],
    ["Read more at https://example.org.", "summary:link_or_handle"],
    ["Build robots. They create. Everyone learns. Neighbors share. Skills develop. People connect.", "summary:too_many_sentences"],
    ["Build robots. Win a raffle.", "summary:unsupported_claim_word:raffle"],
    ["Build robots on Tuesday.", "summary:unsupported_date_word:tuesday"],
    ["Build robots", "summary:unfinished_sentence"],
    ["- Build robots.", "summary:list_formatting"],
    ["Build robots. Build robots.", "summary:repeated_sentence"],
    ["Build robots.\u7121", "summary:foreign_characters"],
  ])("holds a story validation violation: %s", (summary, error) => {
    expect(validateItem(story, draft(summary))).toContain(error);
  });
  it("keeps news date policy and model prompts aligned", () => {
    const news = { ...story, kind: "state_news" };
    expect(validateItem(news, draft("The U.S. Geological Survey published this on Tuesday.", "Robot Lab publishes news"))).not.toContain("summary:repeats_when_where");
    expect(itemPrompt(story)).toContain("Mention a deadline or other date in prose only when it is stated in the source");
    expect(itemPrompt({ ...story, title: "Café Robot Lab" })).toContain("Caf\\u00e9 Robot Lab");
  });
  it("allows grounded date context and headline overlap without weakening factual or repetition checks", () => {
    const deadline = { ...story, description: `${story.description} Apply by Tuesday.` };
    expect(validateItem(deadline, draft("Apply by Tuesday to build small robots."))).toEqual([]);
    expect(validateItem(deadline, draft("Apply by Wednesday to build small robots."))).toContain("summary:unsupported_date_word:wednesday");
    expect(validateItem(story, draft("Robot Lab welcomes young builders. Build robots with LEGO kits."))).toEqual([]);
    expect(validateItem(story, draft("Build robots. Build robots."))).toContain("summary:repeated_sentence");
    expect(validateItem(story, draft("Builders may explore robot designs."))).toEqual([]);
  });
  it("rejects the truncated Vancouver front and dangling item headlines", () => {
    const vancouver = { id: "tax", title: "Business Tax Basics with the Department of Revenue", description: "Washington business taxes and excise tax filing." };
    const truncated = "Business Tax Basics with the Department of Revenue covers Washington tax essentials for a";
    const context = editionContext("Vancouver", "Oct 20-26", [vancouver], [{ headline: "Business Tax Basics explains Washington taxes", summary: "Learn about excise tax filing." }]);
    expect(validateFront(context, [vancouver], { headline: truncated, intro: "Learn about Washington taxes." })).toContain("headline:incomplete_headline");
    expect(validateItem(vancouver, { headline: truncated, summary: "Learn about Washington taxes." })).toContain("headline:incomplete_headline");
    for (const headline of ["Robot Lab welcomes builders with", "Robot Lab welcomes builders...", "Robot Lab (new builders", "Robot Lab invites builders:"]) {
      expect(headlineErrors(headline)).toContain("incomplete_headline");
    }
    expect(headlineErrors("Robot Lab welcomes new builders")).toEqual([]);
  });
  it("accepts five grounded sentences, caps words, and asks for reported context rather than promotion", () => {
    const text = "Build small robots with LEGO kits. Program their movements. Explore how the pieces work together. Try different designs. The activity is for ages 8 to 12.";
    expect(validateItem(story, draft(text))).toEqual([]);
    expect(validateItem(story, draft(`${"Robots ".repeat(121)}work.`))).toContain("summary:too_many_words");
    expect(itemPrompt(story)).toContain("short reported-style article, not a calendar listing");
    expect(itemPrompt(story)).toContain("never pad or fabricate context");
    expect(itemPrompt({ ...story, kind: "trending_topic" })).toContain("do not mention trending, page views");
  });
  it("rejects attention statistics as news even when they appear in source evidence", () => {
    const trend = { ...story, kind: "trending_topic", description: `${story.description} Robot Lab is trending on Wikipedia with 10,765 daily views.` };
    expect(validateItem(trend, { headline: "Robot Lab is trending on Wikipedia", summary: "Robot Lab has 10,765 daily views." })).toContain("attention_statistic_not_news");
    expect(validateItem({ ...trend, kind: "social_trend" }, draft("Robot Lab has viral posts on Bluesky."))).toContain("attention_statistic_not_news");
    expect(validateItem(trend, draft("Build and program small robots with LEGO kits."))).not.toContain("attention_statistic_not_news");
    const context = editionContext("Auburn", "Oct 20-26", [trend], [draft("Build robots.")]);
    expect(validateFront(context, [trend], { headline: "Robot Lab is trending", intro: "Robot Lab gets 10,765 daily views." })).toContain("attention_statistic_not_news");
    expect(validateEmail({ ...context, headline: "Robot Lab", intro: "Build robots." }, [trend], { blurb: "Robot Lab is trending." })).toContain("attention_statistic_not_news");
  });
  it("retries an incomplete front then uses the safe fallback if it stays incomplete", async () => {
    const model = new FakeModel(() => ({ headline: "Robot Lab welcomes new builders for", intro: "Explore robot programming." }));
    const front = await writeFront(model, "Auburn", "Oct 20-26", [story], [draft("Build robots with LEGO kits.")]);
    expect(front).toMatchObject({ fallback: true, attempts: 2, headline: "Auburn this week: Oct 20-26" });
    expect(model.calls[1].prompt).toContain("Rewrite a shorter complete headline");
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
