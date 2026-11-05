export type ScanDiagnostic = {
  scan: number; sort?: 'RECENT_ACTIVITY' | 'CHRONOLOGICAL'; feed: boolean; articles: number; outsideFeedArticles: number;
  commentArticles: number; commentLinks: number; postLinks: number;
  messageNodes: number; fallbackNodes: number; candidateItems: number;
  newItems: number; recentItems: number; olderItems: number;
  expandedButtons?: number; truncatedBeforeRetry?: number; truncatedAfterRetry?: number;
};
export type ArticleSample = {
  scan: number; label: 'comment' | 'other'; nested: boolean; hasText: boolean;
  linkKinds: ('numeric_post' | 'opaque_post' | 'other_group' | 'other_facebook' | 'external')[];
  hasUsablePostLink: boolean; linkInList: boolean; hasMessage: boolean;
  fallbackNodes: number; hasTime: boolean;
  rejection: 'comment_labeled' | 'nested_article' | 'missing_body' | 'candidate';
};
export type PageView = { scan: number; feedHtml: string; visibleText: string };
export type CapturedArticle = { scan: number; label: 'comment' | 'other'; text: string; html: string };
export type RunDiagnostics = { version: 1; scans: ScanDiagnostic[]; samples: ArticleSample[]; pageViews?: PageView[]; articles?: CapturedArticle[]; steps?: { sort: 'RECENT_ACTIVITY' | 'CHRONOLOGICAL'; status: string; posts: number }[] };
const scanNumbers = ['scan', 'articles', 'outsideFeedArticles', 'commentArticles', 'commentLinks', 'postLinks', 'messageNodes', 'fallbackNodes', 'candidateItems', 'newItems', 'recentItems', 'olderItems'] as const;
const optionalScanNumbers = ['expandedButtons', 'truncatedBeforeRetry', 'truncatedAfterRetry'] as const;
const kinds = new Set<ArticleSample['linkKinds'][number]>(['numeric_post', 'opaque_post', 'other_group', 'other_facebook', 'external']);
const rejections = new Set<ArticleSample['rejection']>(['comment_labeled', 'nested_article', 'missing_body', 'candidate']);
const number = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 13500;

// Only schema-approved structural facts may enter the persisted run or downloadable artifact.
export function safeDiagnostics(input: unknown): RunDiagnostics | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const data = input as Record<string, unknown>;
  if (data.version !== 1 || !Array.isArray(data.scans) || data.scans.length > 45 || !Array.isArray(data.samples) || data.samples.length > 24) return;
  const scans: ScanDiagnostic[] = [];
  for (const value of data.scans) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const source = value as Record<string, unknown>;
    if (typeof source.feed !== 'boolean' || scanNumbers.some(key => !number(source[key])) ||
          optionalScanNumbers.some(key => source[key] !== undefined && !number(source[key])) || (source.scan as number) >= 45) return;
        if (source.sort !== undefined && !['RECENT_ACTIVITY', 'CHRONOLOGICAL'].includes(String(source.sort))) return;
        const entry = { feed: source.feed, ...(source.sort ? { sort: source.sort } : {}) } as ScanDiagnostic;
        for (const key of [...scanNumbers, ...optionalScanNumbers]) if (source[key] !== undefined) Object.assign(entry, { [key]: source[key] });
    scans.push(entry);
  }
  const samples: ArticleSample[] = [];
  for (const value of data.samples) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const source = value as Record<string, unknown>;
    if (!number(source.scan) || (source.scan as number) >= 45 || !number(source.fallbackNodes) ||
      !['comment', 'other'].includes(String(source.label)) || !rejections.has(source.rejection as ArticleSample['rejection']) ||
      ['nested', 'hasText', 'hasUsablePostLink', 'linkInList', 'hasMessage', 'hasTime'].some(key => typeof source[key] !== 'boolean') ||
      !Array.isArray(source.linkKinds) || source.linkKinds.length > 5 || !source.linkKinds.every(kind => kinds.has(kind))) return;
    samples.push({ scan: source.scan as number, label: source.label as ArticleSample['label'], nested: source.nested as boolean,
      hasText: source.hasText as boolean, linkKinds: [...source.linkKinds], hasUsablePostLink: source.hasUsablePostLink as boolean,
      linkInList: source.linkInList as boolean, hasMessage: source.hasMessage as boolean, fallbackNodes: source.fallbackNodes as number,
      hasTime: source.hasTime as boolean, rejection: source.rejection as ArticleSample['rejection'] });
  }
  const pageViews: PageView[] = [];
  if (data.pageViews !== undefined) {
    if (!Array.isArray(data.pageViews) || data.pageViews.length > 2) return;
    for (const value of data.pageViews) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const view = value as Record<string, unknown>;
      if (!number(view.scan) || (view.scan as number) >= 45 || typeof view.feedHtml !== 'string' || view.feedHtml.length > 32000 ||
        typeof view.visibleText !== 'string' || view.visibleText.length > 8000) return;
      pageViews.push({ scan: view.scan as number, feedHtml: view.feedHtml, visibleText: view.visibleText });
    }
  }
  const articles: CapturedArticle[] = [];
  if (data.articles !== undefined) {
    if (!Array.isArray(data.articles) || data.articles.length > 120) return;
    for (const value of data.articles) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const article = value as Record<string, unknown>;
      if (!number(article.scan) || (article.scan as number) >= 45 || !['comment', 'other'].includes(String(article.label)) ||
        typeof article.text !== 'string' || article.text.length > 1000 || typeof article.html !== 'string' || article.html.length > 2000) return;
      articles.push({ scan: article.scan as number, label: article.label as CapturedArticle['label'], text: article.text, html: article.html });
    }
  }
  let steps: RunDiagnostics['steps'];
  if (data.steps !== undefined) {
    if (!Array.isArray(data.steps) || data.steps.length !== 2) return;
    steps = [];
    for (const value of data.steps) {
      if (!value || typeof value !== 'object') return;
      const step = value as Record<string, unknown>;
      if (!['RECENT_ACTIVITY', 'CHRONOLOGICAL'].includes(String(step.sort)) || typeof step.status !== 'string' || !/^(?:partial_[a-z_]+|login_required|layout_unsupported|failed)$/.test(step.status) || !number(step.posts) || (step.posts as number) > 250) return;
      steps.push({ sort: step.sort as 'RECENT_ACTIVITY' | 'CHRONOLOGICAL', status: step.status, posts: step.posts as number });
    }
  }
  return { version: 1, scans, samples, ...(data.pageViews !== undefined ? { pageViews } : {}), ...(data.articles !== undefined ? { articles } : {}), ...(steps ? { steps } : {}) };
}
