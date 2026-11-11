import { describe, expect, it } from "vitest";
import { addedClaims } from "../../model/news-blurb";
import { eventName, nameErrors, headlineErrors, itemPrompt, styleErrors, validateFront, validateEmail, editionContext, validateItem, writeItem, writeEmail, writeFront, type StoryInput } from "../../model/story-writer";
import { parseTrumba } from "../../connectors/library/parsers";
import { FakeModel } from "../support/fake-model";

const story: StoryInput = { id: "robot-lab", title: "Robot Lab", description: "Build and program small robots with LEGO kits. Ages 8 to 12.", venues: ["Ballard Branch"] };
const draft = (summary: string, headline = "Robot Lab welcomes young builders") => ({ headline, summary });

it("compares encoded feed titles as their displayed event names while still rejecting unrelated names", () => {
  const title = "Kaleidoscope Play &#38; Learn / &#19975;&#33457;";
  expect(eventName(title)).toBe("Kaleidoscope Play & Learn");
  expect(nameErrors("Kaleidoscope Play & Learn at the library", title)).toEqual([]);
  expect(nameErrors("Fun activities at the library", title)).toEqual(["drops_event_name"]);
  const xml = `<rss><channel><item><title>Kaleidoscope Play &amp;#38; Learn / &amp;#19975;&amp;#33457;</title><guid>one</guid><link>https://www.spl.org/event/one</link><category>2026/11/02</category><description><![CDATA[Monday 2 pm<br/>Location Link: Beacon Hill Branch<br/>A library program]]></description></item></channel></rss>`;
  expect(parseTrumba(new TextEncoder().encode(xml)).events[0].title).toBe("Kaleidoscope Play & Learn / 万花");
});

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


describe("source-grounded quantities and news dates", () => {
  it.each([
    ["Ages 8 to 15 can build robots.", "15"],
    ["The lab has 200 kits.", "200"],
    ["The lab has $8 in supplies.", "$8"],
    ["The lab expanded by 12%.", "12%"],
    ["The lab has 8 million kits.", "8million"],
  ])("holds invented or changed quantities: %s", async (summary, quantity) => {
    const model = new FakeModel(() => draft(summary));
    expect(await writeItem(model, story)).toMatchObject({ disposition: "held", attempts: 2, validation_errors: expect.arrayContaining([`summary:unsupported_number:${quantity}`]) });
    expect(model.calls[1].prompt).toContain("Preserve their units and meaning");
  });
  it("allows equivalent numeric formatting and explicitly supported quantities", () => {
    const source = { ...story, description: "Robot Lab received $1,000.00 and expanded by 12 percent. It has 8 million kits." };
    expect(validateItem(source, draft("Robot Lab received $1000 and expanded by 12%. It has 8 million kits."))).toEqual([]);
  });
  it("checks numbers in headlines and dates in news as well as events", () => {
    expect(validateItem(story, draft("Build robots.", "Robot Lab gets 50 kits"))).toContain("headline:unsupported_number:50");
    const news = { ...story, kind: "local_news", description: "Robot Lab opens on Tuesday." };
    expect(validateItem(news, draft("Robot Lab opens on Wednesday."))).toContain("summary:unsupported_date_word:wednesday");
    expect(validateItem(news, draft("Robot Lab opens on tuesday."))).not.toContain("summary:unsupported_date_word:tuesday");
  });
  it("does not let earlier generated text authorize invented front or email facts", () => {
    const drafts = [draft("Robot Lab has 500 kits on Wednesday.")];
    const context = editionContext("Auburn", "Nov 1–7", [story], drafts);
    const front = { headline: "Robot Lab gets 500 kits", intro: "Build with 500 kits." };
    expect(validateFront(context, [story], front)).toEqual(expect.arrayContaining(["headline:unsupported_number:500", "intro:unsupported_number:500"]));
    expect(validateEmail({ ...context, ...front }, [story], { blurb: "Explore 500 kits on Wednesday." })).toEqual(expect.arrayContaining(["blurb:unsupported_number:500", "blurb:unsupported_date_word:wednesday"]));
  });
  it("holds whitespace-only structured responses", async () => {
    expect(await writeItem(new FakeModel(() => ({ headline: " ", summary: " " })), story)).toMatchObject({ disposition: "held", error: expect.stringContaining("Invalid structured response") });
  });
});

it("checks numeric claims independently of the configured voice", () => {
  const previous = process.env.NEWSBEE_VOICE;
  process.env.NEWSBEE_VOICE = "plain";
  try {
    expect(validateItem({ id: "homes", title: "Council housing proposal", kind: "news_report", description: "The council will consider a proposal for 20 homes." }, { headline: "Council housing proposal", summary: "The council approved 200 homes." }))
      .toEqual(expect.arrayContaining(["summary:unsupported_number:200", "summary:unsupported_status:approval"]));
  } finally { if (previous === undefined) delete process.env.NEWSBEE_VOICE; else process.env.NEWSBEE_VOICE = previous; }
});
it("rejects reversed registration requirements but accepts supported negation", () => {
  const input = { id: "lab", title: "Robot Lab", description: "Registration is not required." };
  expect(validateItem(input, draft("Registration is required."))).toContain("summary:unsupported_status:registration");
  expect(validateItem(input, draft("Registration is not required."))).toEqual([]);
  expect(validateItem({ ...input, description: "Registration is required." }, draft("Registration is not required."))).toContain("summary:unsupported_status:registration");
});
it("rejects invented news dates as well as event dates", () => {
  expect(validateItem({ ...story, kind: "news_report" }, draft("Robot Lab opens on Wednesday."))).toContain("summary:unsupported_date_word:wednesday");
});
it("rejects invented direct quotations", () => {
  expect(validateItem(story, draft('The speaker said “Robots will save the world.”'))).toContain("summary:unsupported_quotation");
});
it("does not infer rejection from a pending proposal, or approval from a negated source", () => {
  const input = { id: "housing", title: "Council housing proposal", kind: "news_report", description: "The council will consider a proposal for 20 homes." };
  expect(validateItem(input, { headline: input.title, summary: "The council has not approved 20 homes." })).toContain("summary:unsupported_status:approval");
  expect(validateItem({ ...input, description: "The council has not approved 20 homes." }, { headline: input.title, summary: "The council approved 20 homes." })).toContain("summary:unsupported_status:approval");
});

it("does not treat stress-free enrollment as evidence of free admission", () => {
  const input = { id: "enrollment", title: "Enrollment Info Session", description: "Learn about school choice. Make enrollment stress-free." };
  const article = { headline: input.title, summary: "The session is free and open to all families." };
  expect(validateItem(input, article)).toContain("summary:unsupported_claim_word:free");
  expect(validateItem({ ...input, description: `${input.description} Admission is free.` }, article)).not.toContain("summary:unsupported_claim_word:free");
});
it("checks present-tense approval claims as well as past-tense approval", () => {
  const input = { id: "permit", title: "City Building Project", kind: "development", description: "City recorded a building project. Window replacement is subject to field inspection." };
  expect(validateItem(input, { headline: "City Building Project: City Approves Work", summary: "Window replacement is subject to field inspection." })).toContain("headline:unsupported_status:approval");
});
it('normalizes monetary scale without losing currency or meaning', () => {
  const input = { id: 'budget', title: 'Council housing project', kind: 'news_report', description: 'The council recorded a $1,000,000 project estimate.' };
  expect(validateItem(input, { headline: input.title, summary: 'The council recorded a $1 million project estimate.' })).toEqual([]);
  expect(validateItem(input, { headline: input.title, summary: 'The project estimate is £1 million.' })).toContain('summary:unsupported_number:£1million');
});
it('holds source-internal meeting date conflicts even for news-classified notices', () => {
  const input = { id: 'meeting', title: 'November Board Meeting on November 10th', kind: 'local_news', description: 'Please note a schedule change. Our board meeting is on November 7th at 7 p.m.' };
  expect(validateItem(input, { headline: input.title, summary: 'The board meeting is on November 10th.' })).toContain('unsupported_source_conflict:event_dates');
});
it('keeps ordinary permit records distinct from superlative records', () => {
  const input = { id: 'permit', title: 'Council Building Project', kind: 'development', description: 'The city recorded window replacement work.' };
  expect(validateItem(input, { headline: input.title, summary: 'The permit record describes window replacement work.' })).not.toContain('summary:unsupported_superlative:record');
});
it('preserves a complete hyphenated program name such as Genealogy Drop-In', () => {
  expect(headlineErrors('Genealogy Drop-In')).toEqual([]);
  expect(headlineErrors('Genealogy welcomes people in')).toContain('incomplete_headline');
});

it.each(['is scheduled for', 'is set for', 'will take place on', 'is on'])('holds an unresolved event date conflict expressed as %s', wording => {
 const input={id:'board',title:'Community Board Meeting — November 10, 2026',kind:'local_news',description:`The Community Board Meeting ${wording} November 7, 2026.`};
 expect(validateItem(input,{headline:'Community Board Meeting',summary:input.description})).toContain('unsupported_source_conflict:event_dates');
});
