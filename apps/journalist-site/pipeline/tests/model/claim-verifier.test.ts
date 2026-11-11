import { expect, it } from 'vitest';
import { articleClaims, validateVerification, verifyArticle } from '../../model/claim-verifier';
import { FakeModel } from '../support/fake-model';
import { ModelRateLimitError } from '../../model/runtime';
const input = { title: 'School closure', description: 'Veterans Day is a no-school day on November 11.' };
const draft = { headline: 'School closure', summary: 'School is closed on November 11.' };
const rows = () => ({ claims: articleClaims(draft).map(claim => ({ id: claim.id, verdict: 'supported', reason: 'Closure is explicit.', evidence: [{ source_id: 'input', quote: 'Veterans Day is a no-school day on November 11.' }] })) });
it('requires exact source evidence and complete claim coverage', () => {
  expect(validateVerification(rows(), input, draft).checks_passed).toBe(true);
  const omitted = rows(); omitted.claims.pop(); expect(validateVerification(omitted, input, draft).errors).toContain('unsupported_verification:coverage');
  const invented = rows(); invented.claims[0].evidence[0].quote = 'Staff attend a ceremony.'; expect(validateVerification(invented, input, draft).checks_passed).toBe(false);
  const unknown = rows(); unknown.claims[0].evidence[0].source_id = 'outside'; expect(validateVerification(unknown, input, draft).checks_passed).toBe(false);
  const duplicated = rows(); duplicated.claims[1].id = 'headline'; expect(validateVerification(duplicated, input, draft).checks_passed).toBe(false);
});
it.each(['unsupported', 'contradicted', 'conflict'])('holds a %s sentence even if every other claim is supported', verdict => {
  const report = rows(); report.claims[1].verdict = verdict;
  expect(validateVerification(report, input, draft).errors).toContain(`unsupported_verification:${verdict}:sentence-1`);
});
it('fails closed on malformed and unfinished verification', async () => {
  expect((await verifyArticle(new FakeModel(() => ({})), input, draft)).checks_passed).toBe(false);
  expect((await verifyArticle(new FakeModel(() => 'invalid JSON'), input, draft)).checks_passed).toBe(false);
});
it('propagates model quota backoff instead of turning it into an editorial verdict', async () => {
  await expect(verifyArticle(new FakeModel(() => { throw new ModelRateLimitError('quota', 30); }), input, draft)).rejects.toBeInstanceOf(ModelRateLimitError);
});
it('gives a rejected semantic draft one bounded rewrite and verifies the replacement', async () => {
  const { writeItem } = await import('../../model/story-writer');
  let drafts = 0;
  const story = { id: 'closure', title: 'School closure', description: 'Schools are closed.' };
  const model = new FakeModel(({ prompt }) => {
    if (!prompt.startsWith('Independently fact-check')) return { headline: 'School closure', summary: ++drafts === 1 ? 'Staff attend a ceremony.' : 'Schools are closed.' };
    const data = JSON.parse(prompt.split('Review data:\n')[1]);
    return { claims: data.claims.map((claim: { id: string; text: string }) => ({ id: claim.id, verdict: claim.text.includes('ceremony') ? 'unsupported' : 'supported', reason: claim.text.includes('ceremony') ? 'No ceremony is stated.' : 'Explicit source statement.', evidence: claim.text.includes('ceremony') ? [] : [{ source_id: 'input', quote: 'Schools are closed.' }] })) };
  });
  const result = await writeItem(model, story, { verify: true });
  expect(result).toMatchObject({ attempts: 2, disposition: 'checks_passed', draft: { summary: 'Schools are closed.' }, verification: { checks_passed: true } });
  expect(model.calls).toHaveLength(4);
});
it('can use an exact source brief after invented padding fails, but never overrides a source conflict', async () => {
  const { sourceBrief } = await import('../../model/story-writer');
  const source = { id: 'closure', title: 'School closure', description: 'Schools are closed on Veterans Day.' };
  expect(sourceBrief(source)).toMatchObject({ source_brief: true, draft: { summary: 'Schools are closed on Veterans Day.' }, verification: { method: 'exact_source_brief', checks_passed: true } });
  expect(sourceBrief({ id: 'meeting', title: 'Board meeting on November 10', description: 'The board meeting is on November 7.' })).toBeNull();
});
it('does not forget an earlier source conflict when a rewrite fails a different check', async () => {
  const { writeItem } = await import('../../model/story-writer');
  let attempts = 0;
  const model = new FakeModel(({ prompt }) => {
    if (!prompt.startsWith('Independently fact-check')) return { headline: 'School closure', summary: ++attempts === 1 ? 'Schools are closed.' : 'Schools are closed for 44 days.' };
    const data = JSON.parse(prompt.split('Review data:\n')[1]);
    return { claims: data.claims.map((claim: { id: string }) => ({ id: claim.id, verdict: 'conflict', reason: 'The source documents disagree.', evidence: [] })) };
  });
  const result = await writeItem(model, { id: 'closure', title: 'School closure', description: 'Schools are closed.' }, { verify: true });
  expect(result).toMatchObject({ disposition: 'held' });
  expect(result.source_brief).toBeUndefined();
});
it('discards generated padding and invented quantities before constructing a separate exact-source brief', async () => {
  const { writeItem } = await import('../../model/story-writer');
  const story = { id: 'closure', title: 'School closure', description: 'Schools are closed on Veterans Day.' };
  const padded = await writeItem(new FakeModel(() => ({ headline: story.title, summary: 'Schools are closed. Schools are closed.' })), story, { verify: true });
  expect(padded).toMatchObject({ source_brief: true, draft: { summary: story.description }, verification: { method: 'exact_source_brief' } });
  const invented = await writeItem(new FakeModel(() => ({ headline: story.title, summary: 'Schools are closed for 44 days.' })), story, { verify: true });
  expect(invented).toMatchObject({ disposition: 'checks_passed', source_brief: true, draft: { summary: story.description }, verification: { method: 'exact_source_brief' } });
  expect((invented.draft as { summary: string }).summary).not.toContain('44');
  expect(invented.rejected_final).toMatchObject({ errors: expect.arrayContaining(['summary:unsupported_number:44']) });
});
