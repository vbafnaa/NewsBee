import { describe, expect, it } from 'vitest';
import { expiredDeadlineErrors, itemPrompt } from '../../model/story-writer';
describe('edition-relative deadline wording', () => {
  const story = { id: 'dahl', title: 'Dahl Field renovation', as_of: '2026-11-09' };
  it('rejects the actual stale bid wording', () => {
    expect(expiredDeadlineErrors(story, 'The city currently has procurement documents published with the bid set to close on November 4th.')).toEqual(['expired_deadline_presented_as_open']);
  });
  it('omits expired open-deadline wording from authoring input without dropping other facts', () => {
    const prompt = itemPrompt({ ...story, description: 'The restroom was damaged by fire. The bid is set to close November 4th. Construction is planned for summer 2027.' });
    expect(prompt).not.toContain('The bid is set to close November 4th.');
    expect(prompt).toContain('Construction is planned for summer 2027.');
  });
  it('allows attributed historical deadlines without inferring an outcome', () => {
    expect(expiredDeadlineErrors(story, 'The source listed November 4 as the bid deadline.')).toEqual([]);
    expect(expiredDeadlineErrors(story, 'Bids were scheduled to close November 4.')).toEqual([]);
  });
  it('allows future and same-day deadlines', () => {
    expect(expiredDeadlineErrors(story, 'Bids close November 10.')).toEqual([]);
    expect(expiredDeadlineErrors(story, 'Applications are due November 9.')).toEqual([]);
  });
  it('does not flag future construction goals or ordinary historical reporting', () => {
    expect(expiredDeadlineErrors(story, 'Construction is planned for summer 2027.')).toEqual([]);
    expect(expiredDeadlineErrors(story, 'The city published bid documents on November 4.')).toEqual([]);
  });
  it('handles explicit past years and leaves ambiguous yearless dates alone', () => {
    expect(expiredDeadlineErrors(story, 'Applications are due December 4, 2025.')).toHaveLength(1);
    expect(expiredDeadlineErrors(story, 'Applications are due January 4.')).toEqual([]);
  });
});
