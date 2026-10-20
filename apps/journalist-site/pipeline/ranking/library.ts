import { compareKeys, type Story } from "../editions/stories";

export const PRACTICAL = /\b(services?|help|resources?|assistance|support|tax(es)?|legal|health|housing|jobs?|careers?|employment|citizenship|benefits?|vot(e|er|ers|ing)|clinic|insurance|medicare|financ\w*)\b/i;

export function rank(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => compareKeys(
    [a.recurring, !PRACTICAL.test(a.title), a.first.event_date, a.title],
    [b.recurring, !PRACTICAL.test(b.title), b.first.event_date, b.title],
  ));
}
