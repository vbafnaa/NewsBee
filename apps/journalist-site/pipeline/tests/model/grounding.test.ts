import { expect, it } from "vitest";
import { namedEntityErrors, groundingErrors, hasFactualityError, reportingErrors } from "../../model/grounding";
import { validateItem, writeItem } from "../../model/story-writer";
import { eventDateErrors } from "../../editorial/policy";
import { FakeModel } from "../support/fake-model";

it("rejects invented quotes, but allows exact excerpts across typographic quotes and whitespace", () => {
  expect(groundingErrors('The council called it "a historic victory".', ["The council discussed the garden."])).toContain("unsupported_quote");
  expect(groundingErrors('The council called it “a useful space”.', ['The council called it "a useful  space".'])).toEqual([]);
});
it.each([
  ["The council approved the garden.", "The council will consider the garden. No vote has taken place.", "unsupported_decision"],
  ["The council approved the garden.", "The council has not approved the garden.", "unsupported_decision"],
  ["Construction started.", "Construction has not started.", "unsupported_completion"],
  ["The playground opened.", "The playground will open after construction is completed.", "unsupported_completion"],
])("does not upgrade uncertainty or negation: %s", (draft, source, error) => {
  expect(groundingErrors(draft, [source])).toContain(error);
});
it("allows confirmed decisions and preserves negated or conditional outcomes", () => {
  expect(groundingErrors("The council approved the garden.", ["The council approved a garden on Tuesday."])).toEqual([]);
  expect(groundingErrors("Construction has not started.", ["Construction has not started."])).toEqual([]);
  expect(groundingErrors("The garden would open after construction is completed.", ["A garden is proposed."])).toEqual([]);
});
it("holds promotion observed in actual local-model drafts", async () => {
  const story = { id: "school", title: "No School Veterans Day", description: "Veterans Day Observed (no school)." };
  const model = new FakeModel(() => ({ headline: "No School Veterans Day", summary: "Celebrate Veterans Day with a day off from school! Don't miss out on this meaningful observance." }));
  expect(await writeItem(model, story)).toMatchObject({ disposition: "held", attempts: 2, validation_errors: expect.arrayContaining(["summary:promotional_language"]) });
  expect(model.calls[1].prompt).toContain("Sparse evidence should produce a short factual brief");
});
it("accepts concise factual briefs and preserves actual event names", () => {
  expect(validateItem({ id: "school", title: "No School Veterans Day", description: "Veterans Day Observed (no school)." }, { headline: "No School Veterans Day", summary: "School will be closed for Veterans Day." })).toEqual([]);
  expect(reportingErrors("Magical Adventure", "Magical Adventure", true)).toEqual([]);
});
it("keeps factual failures distinct from relaxable style checks", () => {
  expect(hasFactualityError(["summary:unsupported_quote"])).toBe(true);
  expect(hasFactualityError(["headline:unsupported_number:99"])).toBe(true);
  expect(hasFactualityError(["summary:too_many_words"])).toBe(false);
});

it("holds contradictory calendar dates instead of choosing a convenient version", () => {
  expect(eventDateErrors({ title: "Board meeting November 10", description: "Our board meeting is November 7 at the hall.", kind: "event", first_date: "2026-11-10" })).toEqual(["conflicting_event_dates"]);
  expect(eventDateErrors({ title: "Board meeting November 10", description: "Our board meeting is November 10.", kind: "event", first_date: "2026-11-07" })).toEqual(["conflicting_event_dates"]);
  expect(eventDateErrors({ title: "Board meeting November 10", description: "The board meeting is November 10. Submit questions by November 7.", first_date: "2026-11-10" })).toEqual([]);
  expect(eventDateErrors({ title: "November 2026 board meeting", description: "The meeting is planned." })).toEqual([]);
});

it("rejects invented reasons for a factual announcement", () => {
  expect(groundingErrors("Schools are closed to honor our military heroes.", ["Veterans Day observed, no school."])).toContain("unsupported_purpose");
  expect(groundingErrors("The program aims to develop literacy skills.", ["The program helps develop literacy skills."])).toEqual([]);
  expect(reportingErrors("Join Family Story Time at the library!", "Family Story Time")).toContain("promotional_language");
  expect(reportingErrors("Drop in for genealogy help.", "Genealogy Drop-In")).toContain("promotional_language");
});

it("holds invented streets and organizations seen in actual model output", () => {
  expect(namedEntityErrors("A garden meeting is planned at Elm Street by the Garden Club of Oakwood.", ["A garden meeting is planned. Further details have not been announced."])).toEqual(expect.arrayContaining(["unsupported_name:Elm", "unsupported_name:Street", "unsupported_name:Club", "unsupported_name:Oakwood"]));
  expect(namedEntityErrors("Families can visit the Northeast Branch.", ["Northeast Branch offers family activities."])).toEqual([]);
  expect(namedEntityErrors("School will be closed. Students have the day off.", ["No school."])).toEqual([]);
});

it("rejects the local model's fabricated sparse-source article, even without numeric claims", () => {
  const errors = validateItem({ id: "garden", title: "Garden Meeting", kind: "local_news", description: "A garden meeting is planned. Further details have not been announced." }, {
    headline: "Garden Meeting Planned",
    summary: "A garden meeting is planned at the community garden on Elm Street, where attendees will discuss garden maintenance and share tips on sustainable gardening practices. Further details have not been announced by the Garden Club of Oakwood.",
  });
  expect(errors).toEqual(expect.arrayContaining(["summary:unsupported_name:Elm", "summary:unsupported_name:Oakwood"]));
});
it('does not convert a contractor plan into a secured contract or recovery', () => {
  const source = ['Seattle Parks now plans on having the contractor under contract by early 2027 with the goal of construction beginning winter/spring 2027.'];
  expect(groundingErrors('The city is now under contract with a contractor by early 2027.', source)).toContain('unsupported_contract_status');
  expect(groundingErrors('Dahl Field renovation is back on track.', source)).toContain('unsupported_recovery');
  expect(groundingErrors('Seattle Parks plans on having the contractor under contract by early 2027.', source)).toEqual([]);
  expect(groundingErrors('The city is under contract.', ['The city is under contract.'])).toEqual([]);
});
it('rejects regular attendance claims that contradict a no-school notice', () => {
  expect(groundingErrors('Students will attend classes as usual.', ['Veterans Day observed, no school.'])).toContain('unsupported_closure_contradiction');
});
it('preserves expected contract wording without turning it into a secured contract', () => {
  expect(groundingErrors('The contractor is expected to be under contract by early 2027.', ['Seattle Parks plans on having the contractor under contract by early 2027.'])).toEqual([]);
});
