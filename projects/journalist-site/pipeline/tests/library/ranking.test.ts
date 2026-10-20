import { describe, expect, it } from "vitest";
import { rank } from "../../ranking/library";
import { Story } from "../../editions/stories";

function story(title: string, date: string, recurring = false) {
  const item = new Story(title, title, null);
  item.occurrences = Array.from({ length: recurring ? 2 : 1 }, (_, index) => ({ source_id: "library:x", source_event_id: `${title}-${index}`, event_date: date, schedule_text: "", venue: "", room: null, source_url: "" }));
  return item;
}
it("ranks one-offs before recurring, practical topics before other events, then soonest", () => {
  expect(rank([story("Weekly Storytime", "2026-11-01", true), story("Lego Club", "2026-11-02"), story("Tax Help Clinic", "2026-11-05"), story("Job Search Help", "2026-11-04", true), story("Author Talk", "2026-11-01")]).map((item) => item.title)).toEqual(["Tax Help Clinic", "Author Talk", "Lego Club", "Job Search Help", "Weekly Storytime"]);
});
