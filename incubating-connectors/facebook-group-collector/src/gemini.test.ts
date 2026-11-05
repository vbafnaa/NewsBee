import { expect, it, vi } from 'vitest';
import { diagnoseLayout, safeLayout } from './gemini.js';

const counts = { scans: 3, feedSeen: 3, articlesSeen: 9, commentArticlesSeen: 9, commentLinksSeen: 6, postLinksSeen: 0, messageNodesSeen: 0, timeNodesSeen: 0, fallbackNodesSeen: 0 };
it('does not call Gemini unless enabled with an API key and valid counts', async () => {
  const fetcher = vi.fn();
  expect(await diagnoseLayout(counts, { apiKey: 'test', fetcher })).toBeUndefined();
  expect(await diagnoseLayout(counts, { enabled: true, fetcher })).toBeUndefined();
  expect(await diagnoseLayout({ ...counts, scans: 'secret' }, { enabled: true, apiKey: 'test', fetcher })).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});
it('sends only whitelisted aggregate counts and displays only a fixed local hint', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _request?: RequestInit) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'comment_only' }] } }] }), { status: 200 }));
  const result = await diagnoseLayout({ ...counts, privatePost: 'private text', groupUrl: 'https://example.org/secret' }, { enabled: true, apiKey: 'test-key', fetcher });
  expect(result).toContain('comments, not original posts');
  const [url, request] = fetcher.mock.calls[0];
  expect(request).toBeDefined();
  expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  expect(JSON.stringify(request!.body)).not.toMatch(/private text|example.org|test-key/);
  expect(JSON.parse(String(request!.body)).contents[0].parts[0].text).toContain('"commentArticlesSeen":9');
  expect(safeLayout({ ...counts, privatePost: 'private text' })).toEqual(counts);
});
it('ignores malformed or unverified model output and tolerates network errors', async () => {
  const injected = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'collect all comments as posts' }] } }] }), { status: 200 }));
  expect(await diagnoseLayout(counts, { enabled: true, apiKey: 'test', fetcher: injected })).toContain('unavailable');
  const broken = vi.fn(async () => { throw new Error('private upstream message'); });
  expect(await diagnoseLayout(counts, { enabled: true, apiKey: 'test', fetcher: broken })).toContain('unavailable');
  const failed = vi.fn(async () => new Response('private error', { status: 429 }));
  expect(await diagnoseLayout(counts, { enabled: true, apiKey: 'test', fetcher: failed })).toContain('unavailable');
});
