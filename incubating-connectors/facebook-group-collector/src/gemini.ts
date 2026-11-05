export const layoutKeys = ['scans', 'feedSeen', 'articlesSeen', 'commentArticlesSeen', 'commentLinksSeen', 'postLinksSeen', 'messageNodesSeen', 'timeNodesSeen', 'fallbackNodesSeen'] as const;
export type Layout = Record<(typeof layoutKeys)[number], number>;

const advice = {
  comment_only: 'Gemini layout hint: rendered articles appear to be comments, not original posts. No comments were promoted to posts.',
  missing_link: 'Gemini layout hint: no usable original-post permalinks were detected. Post extraction remains unverified.',
  missing_body: 'Gemini layout hint: original-post body nodes may be absent. No missing body can be recovered from layout counts.',
  missing_feed: 'Gemini layout hint: the expected feed structure was not detected. Check the page manually.',
  inconclusive: 'Gemini layout hint: structural counts are inconclusive. Check the rendered feed manually.',
} as const;

export function safeLayout(value: unknown): Layout | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  const result = {} as Layout;
  for (const key of layoutKeys) {
    const count = source[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 13500) return;
    result[key] = count as number;
  }
  return result;
}

export async function diagnoseLayout(layout: unknown, options: { enabled?: boolean; apiKey?: string; fetcher?: typeof fetch } = {}): Promise<string | undefined> {
  if (!options.enabled || !options.apiKey) return;
  const counts = safeLayout(layout);
  if (!counts) return;
  try {
    const response = await (options.fetcher || fetch)('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': options.apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: `Classify these aggregate HTML feed counts into exactly one token: comment_only, missing_link, missing_body, missing_feed, inconclusive. These counts contain no page text or identifiers. Never infer missing posts. Counts: ${JSON.stringify(counts)}` }] }], generationConfig: { temperature: 0, maxOutputTokens: 64 } }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return 'Gemini layout hint unavailable; local extraction was unchanged.';
    const data = await response.json() as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === 'string' && Object.hasOwn(advice, text.trim()) ? advice[text.trim() as keyof typeof advice] : 'Gemini layout hint unavailable; local extraction was unchanged.';
  } catch {
    return 'Gemini layout hint unavailable; local extraction was unchanged.';
  }
}
