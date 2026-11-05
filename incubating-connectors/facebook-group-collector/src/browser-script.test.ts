import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';

const source = await readFile(new URL('./browser-script.js', import.meta.url), 'utf8');
const extract = Function(`return (${source})`)() as (page: any, lookbackHours?: number, cutoffAt?: string | null, firstTen?: boolean, checkpointPath?: string) => Promise<{ status: string; posts: { text: string; commentCount?: number; reactions?: { total?: number; kinds: string[]; counts: Record<string, number> }; contentVerified: boolean; permalink?: string; sourceLinks: string[]; publishedAt?: string; postHtml?: string }[]; diagnostics?: { scans: any[]; samples: any[]; pageViews: { scan: number; feedHtml: string; visibleText: string }[]; articles: { scan: number; label: string; text: string; html: string }[] } }>;

async function fixture(html: string | string[], url = 'https://www.facebook.com/groups/vietseattle', hydrateOnWait = false, onPage?: (document: Document) => void, lookbackHours = 168, cutoffAt?: string, lateHtml?: string, firstTen = false, onWait?: (document: Document, count: number) => void, captured?: string[], checkpointPath?: string, hoveredTime?: string, onScroll?: (document: Document, count: number) => void, onMove?: (x: number) => void, shareRedirect?: string) {
  const pages = Array.isArray(html) ? html : [html];
  const dom = new JSDOM(pages[0], { url });
  const previous = { document: globalThis.document, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle };
  let pageIndex = 0;
  let evaluations = 0;
  let waits = 0;
  let scrolls = 0;
  onPage?.(dom.window.document);
  if (hoveredTime) {
    dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
    const link = dom.window.document.querySelector('a[style*="inline-block"]');
    if (link) link.getBoundingClientRect = () => ({ x: 80, y: 80, width: 100, height: 18 } as DOMRect);
  }
  dom.window.scrollTo = () => undefined;
  dom.window.scrollBy = () => { onScroll?.(dom.window.document, ++scrolls); if (pageIndex < pages.length - 1) { dom.window.document.body.innerHTML = pages[++pageIndex]; onPage?.(dom.window.document); } };
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, getComputedStyle: dom.window.getComputedStyle });
  try {
    return await extract({ url: () => url, context: () => ({ newPage: async () => ({ goto: async () => undefined, url: () => shareRedirect, close: async () => undefined }) }), evaluate: async (callback: (slug: string) => unknown, slug: string) => {
      if (++evaluations === 2 && lateHtml) {
        dom.window.document.querySelector('[role="feed"]')?.insertAdjacentHTML('beforeend', lateHtml);
        onPage?.(dom.window.document);
      }
      return callback(slug);
    }, mouse: { move: async (x: number) => {
      onMove?.(x);
      dom.window.document.querySelector('[role="tooltip"]')?.remove();
      if (x > 0 && hoveredTime) { const tooltip = dom.window.document.createElement('div'); tooltip.setAttribute('role', 'tooltip'); tooltip.textContent = hoveredTime; tooltip.getBoundingClientRect = () => ({ width: 120, height: 20 } as DOMRect); dom.window.document.body.append(tooltip); }
    } }, locator: (selector: string) => ({ hover: async () => {
      if (!dom.window.document.querySelector(selector)) throw new Error('Link missing');
      if (hoveredTime) { const tooltip = dom.window.document.createElement('div'); tooltip.setAttribute('role', 'tooltip'); tooltip.textContent = hoveredTime; tooltip.getBoundingClientRect = () => ({ width: 120, height: 20 } as DOMRect); dom.window.document.body.append(tooltip); }
    }, screenshot: async ({ path }: { path: string }) => { if (!dom.window.document.querySelector(selector)) throw new Error('Card missing'); captured?.push(path); } }), waitForTimeout: async () => { onWait?.(dom.window.document, ++waits); }, waitForFunction: async () => { if (hydrateOnWait && pageIndex < pages.length - 1) dom.window.document.body.innerHTML = pages[++pageIndex];     } }, lookbackHours, cutoffAt, firstTen, checkpointPath);
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}
it('checkpoints captured posts after each scan so a later browser disconnect does not lose them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-checkpoint-'));
  const checkpoint = join(dir, 'scan.json');
  try {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: { body: string }) => { await writeFile(checkpoint, options.body); return { ok: true }; }));
    const html = '<div role="feed"><div role="article"><a href="/groups/vietseattle/posts/4/">post</a><div data-ad-preview="message">First post</div></div></div>';
    await expect(fixture(html, undefined, false, undefined, 168, undefined, undefined, false,
      () => { if (existsSync(checkpoint)) throw new Error('Chrome disconnected'); }, undefined, 'http://127.0.0.1:4000/checkpoint')).rejects.toThrow('Chrome disconnected');
    const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
    expect(saved).toMatchObject({ posts: [{ text: 'First post' }], diagnostics: { scans: [{ scan: 0, newItems: 1 }] } });
    expect(saved.posts).toHaveLength(1);
    expect(saved.posts[0].postHtml).toContain('First post');
  } finally { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); }
});
it('collects ten accepted recent-activity posts regardless of age', async () => {
  const old = new Date(Date.now() - 50 * 86400000).toISOString();
  const cards = Array.from({ length: 12 }, (_, i) => `<div role="article"><a href="/groups/vietseattle/posts/${i + 1}/">post</a><time datetime="${old}"></time><div data-ad-preview="message">Top ${i + 1}</div></div>`).join('');
  const result = await fixture(`<div role="feed">${cards}</div>`, undefined, false, undefined, 1, undefined, undefined, true);
  expect(result.posts.map(post => post.text)).toEqual(Array.from({ length: 10 }, (_, i) => `Top ${i + 1}`));
  expect(result.diagnostics?.scans).toHaveLength(1);
  expect(result.status).not.toBe('partial_cutoff');
});
it('scrolls past rejected cards and repeated posts until ten distinct original posts are accepted', async () => {
  const old = new Date(Date.now() - 50 * 86400000).toISOString();
  const card = (id: number) => `<div role="article"><a href="/groups/vietseattle/posts/${id}/">post</a><time datetime="${old}"></time><div data-ad-preview="message">Top ${id}</div></div>`;
  const rejected = '<div role="article" aria-label="Comment by member"><div data-ad-preview="message">Reply, not a post</div></div>';
  const pages = [
    `<div role="feed">${rejected}${card(1)}${card(2)}</div>`,
    `<div role="feed">${rejected}${card(1)}${card(2)}${card(3)}${card(4)}${card(5)}</div>`,
    `<div role="feed">${rejected}${Array.from({ length: 12 }, (_, i) => card(i + 1)).join('')}</div>`,
  ];
  const result = await fixture(pages, undefined, false, undefined, 1, undefined, undefined, true);
  expect(result.posts.map(post => post.text)).toEqual(Array.from({ length: 10 }, (_, i) => `Top ${i + 1}`));
  expect(result.diagnostics?.scans.map(scan => scan.newItems)).toEqual([2, 3, 5]);
  expect(result.status).not.toBe('partial_fewer_posts');
});
it('keeps scanning when scrolling advances through tall cards without finding a new post yet', async () => {
  const dated = new Date(Date.now() - 3600000).toISOString();
  const card = (id: number) => `<div role="article"><a href="/groups/vietseattle/posts/${id}/">post</a><time datetime="${dated}"></time><div data-ad-preview="message">Post ${id}</div></div>`;
  const result = await fixture(`<div role="feed">${card(1)}</div>`, undefined, false, undefined, 168, undefined, undefined, true,
    undefined, undefined, undefined, undefined, (document, count) => {
      if (count <= 7) Object.defineProperty(document.defaultView, 'scrollY', { value: count * 750, configurable: true });
      if (count === 6) document.querySelector('[role="feed"]')?.insertAdjacentHTML('beforeend', card(2));
    });
  expect(result.posts.map(post => post.text)).toEqual(['Post 1', 'Post 2']);
});
it('bounds scans when the page scrolls but yields no new posts', async () => {
  const dated = new Date(Date.now() - 3600000).toISOString();
  const html = `<div role="feed"><div role="article"><a href="/groups/vietseattle/posts/1/">post</a><time datetime="${dated}"></time><div data-ad-preview="message">Only post</div></div></div>`;
  const result = await fixture(html, undefined, false, undefined, 168, undefined, undefined, true,
    undefined, undefined, undefined, undefined, (document, count) => {
      Object.defineProperty(document.defaultView, 'scrollY', { value: count * 750, configurable: true });
    });
  expect(result.diagnostics?.scans).toHaveLength(11);
  expect(result.posts).toHaveLength(1);
});
it('reports fewer than ten recent-activity posts when the feed stops yielding new originals', async () => {
  const result = await fixture('<div role="feed"><div role="article"><div data-ad-preview="message">Only original</div></div></div>', undefined, false, undefined, 1, undefined, undefined, true);
  expect(result.posts).toHaveLength(1);
  expect(result.status).toBe('partial_fewer_posts');
  expect(result.diagnostics?.scans.length).toBeLessThan(44);
});
it('recovers the original publication time from an SVG-only header link tooltip', async () => {
  const html = '<div role="feed"><div><div class="post-header"><a href="?__cft__[0]=other#?menu"><svg><use xlink:href="#menu"></use></svg>Group controls</a><a href="?__cft__[0]=opaque#?hci" role="link" style="display: inline-block; width: 112px"><span><svg><use xlink:href="#dateGlyph"></use></svg></span></a></div><div data-ad-preview="message">Community update</div><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/123/?comment_id=5" aria-label="2h">2h</a></div></div></div>';
  const label = 'Sunday, October 25, 2026 at 2:27 PM';
  const result = await fixture(html, undefined, false, undefined, 168, undefined, undefined, true, undefined, undefined, undefined, label);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0].publishedAt).toBe(new Date(Date.parse('Sunday, October 25, 2026 2:27 PM')).toISOString());
  expect((result.posts[0] as any).rawTime).toBe(label);
  expect(result.posts[0].postHtml).toBeUndefined();
});
it('recovers an SVG-only post-permalink time without using a comment permalink', async () => {
  const html = '<div role="feed"><div><div class="post-header"><a href="/groups/vietseattle/posts/123/" style="display: inline-block"><svg><use></use></svg></a><a href="/groups/vietseattle/posts/123/?comment_id=5" style="display: inline-block"><svg><use></use></svg></a></div><div data-ad-preview="message">Community notice</div></div></div>';
  const label = 'Sunday, October 25, 2026 at 2:27 PM';
  const result = await fixture(html, undefined, false, undefined, 168, undefined, undefined, true, undefined, undefined, undefined, label);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0]).toMatchObject({ rawTime: label, permalink: 'https://www.facebook.com/groups/vietseattle/posts/123/' });
  expect(result.posts[0].publishedAt).toBe(new Date(Date.parse('Sunday, October 25, 2026 2:27 PM')).toISOString());
});
it('tries the original link directly when its SVG is covered by another element', async () => {
  const html = '<div role="feed"><div role="article"><a href="/groups/vietseattle/posts/123/" style="display: inline-block"><svg><use></use></svg></a><div data-ad-preview="message">Community notice</div></div></div>';
  const label = 'Sunday, October 25, 2026 at 2:27 PM';
  const result = await fixture(html, undefined, false, document => {
    Object.defineProperty(document, 'elementFromPoint', { value: () => document.body });
  }, 168, undefined, undefined, true, undefined, undefined, undefined, label);
  expect(result.posts[0].publishedAt).toBe(new Date(Date.parse('Sunday, October 25, 2026 2:27 PM')).toISOString());
});
it('waits for a virtualized post card to rehydrate before hovering its time link', async () => {
  const label = 'Sunday, October 25, 2026 at 2:27 PM';
  const contents = '<a href="/groups/vietseattle/posts/123/" style="display: inline-block"><svg><use></use></svg></a><div data-ad-preview="message">Community notice</div>';
  let ghostWaits = 0;
  const result = await fixture(`<div role="feed"><div role="article">${contents}</div></div>`, undefined, false, document => {
    const card = document.querySelector('[role="article"]')!;
    card.scrollIntoView = () => { card.innerHTML = '<div data-virtualized="true"></div>'; };
  }, 168, undefined, undefined, true, document => {
    if (document.querySelector('[data-virtualized]') && ++ghostWaits === 3) {
      const card = document.querySelector('[role="article"]')!;
      card.innerHTML = contents;
      card.querySelector('a')!.getBoundingClientRect = () => ({ x: 80, y: 80, width: 100, height: 18 } as DOMRect);
    }
  }, undefined, undefined, label);
  expect(ghostWaits).toBeGreaterThanOrEqual(3);
  expect(result.posts[0]).toMatchObject({ rawTime: label, text: 'Community notice' });
});
it('bounds tooltip probes for a repeated undated card', async () => {
  const html = '<div role="feed"><div role="article"><a href="/groups/vietseattle/posts/123/" style="display: inline-block"><svg><use></use></svg></a><div data-ad-preview="message">Community notice</div></div></div>';
  let probes = 0;
  const result = await fixture(html, undefined, false, document => {
    const link = document.querySelector('a')!;
    link.getBoundingClientRect = () => ({ x: 80, y: 80, width: 100, height: 18 } as DOMRect);
  }, 168, undefined, undefined, true, undefined, undefined, undefined, 'unknown', undefined, x => { if (x > 0) probes++; });
  expect(result.diagnostics?.scans.length).toBeGreaterThan(2);
  expect(probes).toBe(6);
  expect(result.posts[0].publishedAt).toBeUndefined();
});
it('preserves an undated card before hovering virtualizes its markup', async () => {
  const contents = '<a href="/groups/vietseattle/posts/123/" style="display: inline-block"><svg><use></use></svg></a><div data-ad-preview="message">Community notice</div>';
  const result = await fixture(`<div role="feed"><div role="article">${contents}</div></div>`, undefined, false, document => {
    const card = document.querySelector('[role="article"]')!;
    card.scrollIntoView = () => { card.innerHTML = '<div data-virtualized="true"></div>'; };
  });
  expect(result.posts[0].postHtml).toContain('Community notice');
  expect(result.posts[0].postHtml).not.toContain('data-virtualized');
});
it('reads a linkless original card age without using its comment timestamp', async () => {
  const result = await fixture('<div role="feed"><div><a href="/groups/vietseattle/" aria-label="22h">22h</a><div data-ad-preview="message">Old original</div><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/2/?comment_id=5" aria-label="2m">2m</a><div dir="auto">Reply</div></div></div></div>', undefined, false, undefined, 1);
  expect(result.posts).toHaveLength(0);
  const broad = await fixture('<div role="feed"><div><a href="/groups/vietseattle/" aria-label="22h">22h</a><div data-ad-preview="message">Old original</div><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/2/?comment_id=5" aria-label="2m">2m</a><div dir="auto">Reply</div></div></div></div>');
  expect(broad.posts).toHaveLength(1);
  expect(broad.posts[0].publishedAt).toBeTruthy();
  expect(broad.posts[0].text).toBe('Old original');
});
it('reads a displayed calendar time from the original post header, not the reply or body', async () => {
  const html = '<div role="feed"><div><div class="post-header"><a href="/groups/vietseattle/user/1/">Author</a><span dir="auto">October 21 at 8:14 PM</span></div><div data-ad-preview="message">Community notice <span dir="auto">October 22 at 9:00 PM</span></div><div role="article" aria-label="Comment by member"><span dir="auto">October 23 at 1:00 PM</span><div dir="auto">Reply</div></div></div></div>';
  const result = await fixture(html, undefined, false, undefined, 720, undefined, undefined, true);
  expect(result.posts).toHaveLength(1);
  expect((result.posts[0] as any).rawTime).toBe('October 21 at 8:14 PM');
  expect(result.posts[0].publishedAt).toBeTruthy();
  expect(new Date(result.posts[0].publishedAt!).getHours()).toBe(20);
  expect(new Date(result.posts[0].publishedAt!).getMinutes()).toBe(14);
});
it('resolves a plain relative time in the original header when no time link is exposed', async () => {
  const html = '<div role="feed"><div><div class="post-header"><a href="/groups/vietseattle/user/1/">Author</a><span dir="auto">2h</span></div><div data-ad-preview="message">Neighborhood update</div><div role="article" aria-label="Comment by member"><span>2m</span><div dir="auto">Reply</div></div></div></div>';
  const result = await fixture(html, undefined, false, undefined, 1, undefined, undefined, true);
  expect(result.posts).toHaveLength(1);
  expect((result.posts[0] as any).rawTime).toBe('2h');
  expect(Math.abs(Date.now() - Date.parse(result.posts[0].publishedAt!) - 2 * 3600000)).toBeLessThan(60000);
});
it('reads the accessible original-header time when the rendered header link is obfuscated', async () => {
  const html = '<span id="post-date">4 hours ago</span><div role="feed"><div><div class="post-header"><a href="/groups/vietseattle/" role="link"><span aria-labelledby="post-date"><span>q</span><span>7</span></span></a></div><div dir="auto">Community update</div><div role="article" aria-label="Comment by member"><a role="link" href="/groups/vietseattle/posts/9/?comment_id=1"><span aria-labelledby="reply-date">2m</span></a><span id="reply-date">2 minutes ago</span><div dir="auto">Reply</div></div></div></div>';
  const result = await fixture(html, undefined, false, undefined, 24, undefined, undefined, true);
  expect(result.posts).toHaveLength(1);
  expect((result.posts[0] as any).rawTime).toBe('4 hours ago');
  expect(Math.abs(Date.now() - Date.parse(result.posts[0].publishedAt!) - 4 * 3600000)).toBeLessThan(60000);
  const oneHour = await fixture(html, undefined, false, undefined, 1);
  expect(oneHour.posts).toHaveLength(0);
});
it('waits for the original header date to hydrate before saving a post', async () => {
  const html = '<div role="feed"><div><div class="post-header"><a role="link" href="/groups/vietseattle/"><span aria-labelledby="post-date">x</span></a></div><div dir="auto">Community update</div><div role="article" aria-label="Comment by member"><span>2m</span><div dir="auto">Reply</div></div></div></div>';
  const result = await fixture(html, undefined, false, undefined, 24, undefined, undefined, true, (document, count) => {
    if (count === 2) document.body.insertAdjacentHTML('afterbegin', '<span id="post-date">4 hours ago</span>');
  });
  expect(result.posts).toHaveLength(1);
  expect((result.posts[0] as any).rawTime).toBe('4 hours ago');
  expect(result.posts[0].publishedAt).toBeTruthy();
});
it('reconstructs an obfuscated original post-link date from visible glyph positions', async () => {
  const glyphs = [...'Yesterday at 3:30 AM'].map((character, x) => `<span data-x="${x}" style="position:relative">${character === ' ' ? '&nbsp;' : character}͏</span>`).reverse();
  const shuffled = glyphs.flatMap((glyph, x) => [`<span data-x="${x}" style="position:absolute">z͏</span>`, glyph]).join('');
  const html = `<div role="feed"><div><a role="link" href="/groups/vietseattle/posts/123/"><span aria-labelledby="missing"><span>${shuffled}</span></span></a><div data-ad-preview="message">Community update</div><div role="article" aria-label="Comment by member"><a role="link" href="/groups/vietseattle/posts/123/?comment_id=2" aria-label="2 minutes ago">2m</a><div dir="auto">Reply</div></div></div></div>`;
  const result = await fixture(html, undefined, false, document => {
    for (const span of document.querySelectorAll('[data-x]')) {
      span.getBoundingClientRect = () => ({ left: Number(span.getAttribute('data-x')) * 10, top: 10, width: 8, height: 12 } as DOMRect);
    }
  });
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0]).toMatchObject({ permalink: 'https://www.facebook.com/groups/vietseattle/posts/123/', rawTime: 'Yesterday at 3:30 AM' });
  const published = new Date(result.posts[0].publishedAt!);
  expect(published.getDate()).toBe(new Date(Date.now() - 86400000).getDate());
  expect(published.getHours()).toBe(3);
  expect(published.getMinutes()).toBe(30);
});
it('reads a short obfuscated date from a slashless original group-root link', async () => {
  const decoys = Array.from({ length: 20 }, () => '<span style="position:absolute">x͏</span>').join('');
  const html = `<div role="feed"><div><a role="link" href="/groups/vietseattle?__cft__=value"><span aria-labelledby="missing">${decoys}<span data-x="1" style="position:relative">h͏</span><span data-x="0" style="position:relative">4͏</span></span></a><div data-ad-preview="message">Original update</div><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/2/?comment_id=3" aria-label="2m">2m</a><div dir="auto">Reply</div></div></div></div>`;
  const onPage = (document: Document) => {
    for (const span of document.querySelectorAll('[data-x]')) {
      span.getBoundingClientRect = () => ({ left: Number(span.getAttribute('data-x')) * 10, top: 10, width: 8, height: 12 } as DOMRect);
    }
  };
  const result = await fixture(html, undefined, false, onPage, 24);
  expect(result.posts).toHaveLength(1);
  expect((result.posts[0] as any).rawTime).toBe('4h');
  expect(Math.abs(Date.now() - Date.parse(result.posts[0].publishedAt!) - 4 * 3600000)).toBeLessThan(60000);
  expect((await fixture(html, undefined, false, onPage, 1)).posts).toHaveLength(0);
});
it('does not promote an accessible date from the post body or a comment', async () => {
  const html = '<div role="feed"><div><div dir="auto"><a role="link" href="/groups/vietseattle/"><span aria-labelledby="body-date">q</span></a><span id="body-date">4 hours ago</span>Body</div><div role="article" aria-label="Comment by member"><a role="link" href="/groups/vietseattle/posts/9/?comment_id=1"><span aria-labelledby="reply-date">2m</span></a><span id="reply-date">2 minutes ago</span><div dir="auto">Reply</div></div></div></div>';
  const result = await fixture(html, undefined, false, undefined, 24, undefined, undefined, true);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0].publishedAt).toBeUndefined();
});
it('captures the original card only when its publication time remains unknown', async () => {
  const captured: string[] = [];
  const html = `<div role="feed"><div role="article"><div data-ad-preview="message">Undated original</div><div role="article" aria-label="Comment by member"><span>2m</span></div></div><div role="article"><time datetime="${new Date().toISOString()}"></time><div data-ad-preview="message">Dated original</div></div></div>`;
  const result = await fixture(html, undefined, false, undefined, 1, undefined, undefined, true, undefined, captured);
  expect(result.posts).toHaveLength(2);
  expect(result.posts[0].postHtml).toContain('Undated original');
  expect(result.posts[0].postHtml).toContain('Comment by member');
  expect(result.posts[1].postHtml).toBeUndefined();
  expect(captured).toEqual([]);
});
it('does not use a timestamp from post content or a comment as publication time', async () => {
  const html = '<div role="feed"><div><div data-ad-preview="message">Community notice <span dir="auto">October 21 at 8:14 PM</span></div><div role="article" aria-label="Comment by member"><span>2m</span><div dir="auto">Reply</div></div></div></div>';
  const result = await fixture(html, undefined, false, undefined, 1, undefined, undefined, true);
  expect(result.posts).toHaveLength(1);
  expect((result.posts[0] as any).rawTime).toBeUndefined();
  expect(result.posts[0].publishedAt).toBeUndefined();
});
it('leaves publication unknown when only a nested comment exposes a timestamp', async () => {
  const html = '<div role="feed"><div><div data-ad-preview="message">Undated original</div><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/2/?comment_id=5" aria-label="2m">2m</a><div dir="auto">Reply</div></div></div></div>';
  const result = await fixture(html, undefined, false, undefined, 1);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0].publishedAt).toBeUndefined();
  expect(result.status).toBe('partial_unknown_time');
});
it('applies the selected lookback to post timestamps without promoting comments', async () => {
  const article = (id: number, hoursAgo: number) => `<div role="article"><a href="/groups/vietseattle/posts/${id}/">post</a><time datetime="${new Date(Date.now() - hoursAgo * 3600000).toISOString()}"></time><div data-ad-preview="message">Update ${id}</div></div>`;
  const html = `<div role="feed">${article(1, 0.5)}${article(2, 48)}${article(3, 240)}${article(4, 800)}<div role="article" aria-label="Comment by member"><div data-ad-preview="message">Reply</div></div></div>`;
  const oneHour = await fixture(html, undefined, false, undefined, 1);
  const sevenDays = await fixture(html);
  const thirtyDays = await fixture(html, undefined, false, undefined, 720);
  expect(oneHour.posts.map(post => post.text)).toEqual(['Update 1']);
  expect(sevenDays.posts.map(post => post.text)).toEqual(['Update 1', 'Update 2']);
  expect(thirtyDays.posts.map(post => post.text)).toEqual(['Update 1', 'Update 2', 'Update 3']);
});
it('uses the previous-run cutoff for scheduled scans', async () => {
  const article = (id: number, hoursAgo: number) => `<div role="article"><a href="/groups/vietseattle/posts/${id}/">post</a><time datetime="${new Date(Date.now() - hoursAgo * 3600000).toISOString()}"></time><div data-ad-preview="message">Update ${id}</div></div>`;
  const cutoffAt = new Date(Date.now() - 3 * 3600000).toISOString();
  const result = await fixture(`<div role="feed">${article(1, 2)}${article(2, 5)}</div>`, undefined, false, undefined, 168, cutoffAt);
  expect(result.posts.map(post => post.text)).toEqual(['Update 1']);
});
it('expands unmarked original cards before saving their bodies', async () => {
  const html = '<div role="feed"><div><a href="/groups/vietseattle/user/1/">Author</a><div dir="auto"><span id="body">Short post</span><span><div role="button" id="expand">See more</div></span></div><div role="article" aria-label="Comment by member"><div dir="auto">Private reply</div></div></div></div>';
  const result = await fixture(html, undefined, false, document => {
    document.querySelector('#expand')?.addEventListener('click', () => {
      document.querySelector('#body')!.textContent = 'Short post with full details';
      document.querySelector('#expand')?.remove();
    });
  });
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0]).toMatchObject({ text: 'Short post with full details', contentVerified: true });
  expect(result.posts.map(post => post.text).join(' ')).not.toContain('Private reply');
});
it('expands original article bodies without message markers, but not comment articles', async () => {
  const html = '<div role="feed"><div role="article"><a href="/groups/vietseattle/posts/177/">2h</a><div dir="auto"><span id="body">Short post</span><span><div role="button" id="expand">See more</div></span></div><div role="article" aria-label="Comment by member"><div dir="auto">Reply</div><div role="button" id="commentExpand">See more</div></div></div></div>';
  const result = await fixture(html, undefined, false, document => {
    document.querySelector('#expand')?.addEventListener('click', () => {
      document.querySelector('#body')!.textContent = 'Short post with full details';
      document.querySelector('#expand')?.remove();
    });
  });
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0]).toMatchObject({ text: 'Short post with full details', contentVerified: false });
  expect(JSON.stringify(result.posts)).not.toContain('Reply');
});
it('expands a card hydrated after the first expansion pass before archiving', async () => {
  const lateHtml = '<div><a href="/groups/vietseattle/user/1/">Author</a><div dir="auto"><span id="body">Short post</span><span><div role="button" id="expand">See more</div></span></div></div>';
  const result = await fixture('<div role="feed"></div>', undefined, false, document => {
    document.querySelector('#expand')?.addEventListener('click', () => {
      document.querySelector('#body')!.textContent = 'Short post with full details';
      document.querySelector('#expand')?.remove();
    });
  }, 168, undefined, lateHtml);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0]).toMatchObject({ text: 'Short post with full details', contentVerified: true });
});
it('captures multiple unmarked feed-card bodies while excluding decorative text and comment articles', async () => {
  const card = (id: number) => `<div><a href="/groups/vietseattle/user/${id}/">Author</a><div dir="auto">Neighborhood update ${id}</div><blockquote><span dir="auto">Decoration</span></blockquote><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/${id}/">Comment link</a><div dir="auto">Private reply ${id}</div></div></div>`;
  const result = await fixture(`<div role="feed">${card(1)}${card(2)}</div>`);
  expect(result.posts.map(post => post.text)).toEqual(['Neighborhood update 1', 'Neighborhood update 2']);
  expect(result.posts.every(post => post.contentVerified && !post.permalink)).toBe(true);
  expect(result.posts.map(post => post.text).join(' ')).not.toContain('Private reply');
  expect(result.posts.map(post => post.text).join(' ')).not.toContain('Decoration');
});
it('recovers an original permalink from its nested comment URL when the post header links only to the group', async () => {
  const html = '<div role="feed"><div><a href="/groups/vietseattle?__cft__[0]=opaque" aria-label="2h">2h</a><div data-ad-preview="message">Community update</div><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/3399521323586132/?comment_id=123">Reply time</a><div dir="auto">Reply</div></div></div></div>';
  const result = await fixture(html);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0]).toMatchObject({ text: 'Community update', permalink: 'https://www.facebook.com/groups/vietseattle/posts/3399521323586132/' });
});
it('promotes a linkless post when a later scan exposes its comment permalink without counting a second post', async () => {
  const body = '<div data-ad-preview="message">Community update</div>';
  const first = `<div role="feed"><div><a href="/groups/vietseattle/" aria-label="2h">2h</a>${body}</div></div>`;
  const second = `<div role="feed"><div><a href="/groups/vietseattle/" aria-label="2h">2h</a>${body}<div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/123/?comment_id=2">Reply</a></div></div></div>`;
  const result = await fixture([first, second], undefined, false, undefined, 168, undefined, undefined, true);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0].permalink).toBe('https://www.facebook.com/groups/vietseattle/posts/123/');
});
it('recovers a canonical post URL through its share dialog when the feed exposes no post ID', async () => {
  const share = new URL('https://wa.me/');
  share.searchParams.set('text', 'https://www.facebook.com/share/p/abcDEF12/');
  const redirect = new URL('https://www.facebook.com/l.php');
  redirect.searchParams.set('u', share.href);
  const html = `<div role="feed"><div><a href="/groups/vietseattle/">2h</a><div data-ad-preview="message">Community update</div><div role="button" aria-label="Share, send this to friends or post it on your profile."></div></div></div><div role="dialog"><a href="${redirect.href.replaceAll('&', '&amp;')}">Share to WhatsApp</a></div>`;
  const showDialog = (document: Document) => {
    document.querySelector('[role="dialog"]')!.getBoundingClientRect = () => ({ width: 100 } as DOMRect);
  };
  const result = await fixture(html, undefined, false, showDialog, 168, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, undefined, 'https://www.facebook.com/groups/vietseattle/permalink/987654321/');
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0].permalink).toBe('https://www.facebook.com/groups/vietseattle/posts/987654321/');
  const lFacebookHtml = html.replace('https://www.facebook.com/l.php', 'https://l.facebook.com/l.php');
  const lFacebook = await fixture(lFacebookHtml, undefined, false, showDialog, 168, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, undefined, 'https://www.facebook.com/groups/vietseattle/permalink/987654321/');
  expect(lFacebook.posts[0].permalink).toBe('https://www.facebook.com/groups/vietseattle/posts/987654321/');
  const delayed = await fixture(html.replace(/<a href="[^\"]+">Share to WhatsApp<\/a>/, ''), undefined, false, showDialog, 168, undefined, undefined, false,
    (document, count) => { if (count === 3) document.querySelector('[role="dialog"]')!.insertAdjacentHTML('beforeend', `<a href="${redirect.href.replaceAll('&', '&amp;')}">Share to WhatsApp</a>`); },
    undefined, undefined, undefined, undefined, undefined, 'https://www.facebook.com/groups/vietseattle/permalink/987654321/');
  expect(delayed.posts[0].permalink).toBe('https://www.facebook.com/groups/vietseattle/posts/987654321/');
  const differentGroup = await fixture(html, undefined, false, showDialog, 168, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, undefined, 'https://www.facebook.com/groups/other/permalink/987654321/');
  expect(differentGroup.posts[0].permalink).toBeUndefined();
});
it('retries a linkless card when its share options appear on a later scan', async () => {
  const share = new URL('https://wa.me/');
  share.searchParams.set('text', 'https://www.facebook.com/share/p/late123/');
  const redirect = new URL('https://www.facebook.com/l.php');
  redirect.searchParams.set('u', share.href);
  const html = '<div role="feed"><div><a href="/groups/vietseattle/">2h</a><div data-ad-preview="message">Community update</div><div role="button" aria-label="Share, send this to friends or post it on your profile."></div></div></div>';
  const result = await fixture(html, undefined, false, undefined, 168, undefined, undefined, true,
    undefined, undefined, undefined, undefined, (document, count) => {
      if (count === 1) {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = `<a href="${redirect.href.replaceAll('&', '&amp;')}">Share to WhatsApp</a>`;
        dialog.getBoundingClientRect = () => ({ width: 100 } as DOMRect);
        document.body.append(dialog);
      }
    }, undefined, 'https://www.facebook.com/groups/vietseattle/permalink/987654321/');
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0].permalink).toBe('https://www.facebook.com/groups/vietseattle/posts/987654321/');
});
it('does not assign a permalink from comments referring to multiple different posts', async () => {
  const html = '<div role="feed"><div><a href="/groups/vietseattle/">2h</a><div data-ad-preview="message">Community update</div><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/123/?comment_id=1">Reply</a></div><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/456/?comment_id=2">Reply</a></div></div></div>';
  const result = await fixture(html);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0].permalink).toBeUndefined();
});
it('collects original post cards when only comments have article roles', async () => {
  const result = await fixture(`<div role="feed"><div><a href="/groups/vietseattle/posts/901/" aria-label="2h">2h</a><div data-ad-preview="message">Original community update</div><span>3 comments</span><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/902/">comment link</a><div dir="auto">A private reply</div></div></div></div>`);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0]).toMatchObject({ text: 'Original community update', permalink: 'https://www.facebook.com/groups/vietseattle/posts/901/', commentCount: 3, contentVerified: true });
  expect(JSON.stringify(result.posts)).not.toContain('private reply');
  expect((result as any).layout.messageNodesSeen).toBeGreaterThan(0);
  expect((result as any).layout.commentArticlesSeen).toBeGreaterThan(0);
  expect(result.diagnostics?.samples).toContainEqual(expect.objectContaining({ label: 'other', hasMessage: true, rejection: 'candidate' }));
});
it('keeps linkless post cards separate from comment bodies and empty placeholders', async () => {
  const result = await fixture('<div role="feed"><div><div data-ad-comet-preview="message">Community notice</div><div role="article" aria-label="Comment by member"><div dir="auto">Reply only</div></div></div><div><div role="article"></div></div></div>');
  expect(result.posts.map(post => post.text)).toEqual(['Community notice']);
  expect(result.posts[0].permalink).toBeUndefined();
});
it('captures the post body without comment text and does not mistake comment links for sources', async () => {
  const result = await fixture(`<div role="feed"><div role="article"><a href="/groups/vietseattle/posts/123/" aria-label="Yesterday">Yesterday</a><div data-ad-preview="message"><div dir="auto">Neighborhood gathering on Saturday</div></div><a href="https://example.org/event">event</a><ul><li><a href="https://example.org/comment">Comment author</a><div dir="auto">Looking forward to it</div></li></ul><div role="article"><div dir="auto">Another comment</div></div></div></div>`);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0]).toMatchObject({ text: 'Neighborhood gathering on Saturday', contentVerified: true, permalink: 'https://www.facebook.com/groups/vietseattle/posts/123/', sourceLinks: ['https://example.org/event'] });
  expect(result.posts[0]).not.toHaveProperty('comments');
  expect((result as any).layout.postLinksSeen).toBeGreaterThan(0);
  expect((result as any).layout.messageNodesSeen).toBeGreaterThan(0);
  expect(result.posts[0].text).not.toContain('comment');
});
it('does not promote comments into a missing post body', async () => {
  const result = await fixture('<div role="feed"><div role="article"><a href="/groups/vietseattle/posts/44/">2h</a><ul><li><div dir="auto">This is a comment, not the post</div></li></ul><div role="article"><div dir="auto">Nested comment</div></div></div></div>');
  expect(result.posts).toEqual([]);
});
it('does not mislabel comment articles with post permalinks as posts', async () => {
  const result = await fixture('<div role="feed"><div role="article" aria-label="Comment by a group member"><a href="/groups/vietseattle/posts/44/">2h</a><div dir="auto">A reply to a post</div></div></div>');
  expect(result).toMatchObject({ status: 'partial_comments_only', posts: [] });
  expect((result as any).layout).toMatchObject({ commentArticlesSeen: 3, commentLinksSeen: 3, postLinksSeen: 0 });
  expect(result.diagnostics?.samples[0]).toMatchObject({ label: 'comment', rejection: 'comment_labeled', hasUsablePostLink: true });
  expect(result.diagnostics?.articles).toEqual([expect.objectContaining({ scan: 0, label: 'comment', text: expect.stringContaining('A reply to a post'), html: expect.stringContaining('Comment by a group member') })]);
});
it('distinguishes a feed stuck on empty placeholders from missing original post bodies', async () => {
  const result = await fixture('<div role="feed"><div role="article"></div><div role="article"></div></div>');
  expect(result).toMatchObject({ status: 'partial_feed_unloaded', posts: [] });
  expect((result as any).layout).toMatchObject({ articlesSeen: 6, commentLinksSeen: 0, fallbackNodesSeen: 0 });
  expect(result.diagnostics?.samples[0]).toMatchObject({ rejection: 'missing_body', hasText: false, hasUsablePostLink: false });
  expect(result.diagnostics?.scans).toHaveLength(3);
});
it('waits for placeholder articles to hydrate before concluding a feed has no posts', async () => {
  const result = await fixture([
    '<div role="feed"><div role="article"></div><div role="article"></div></div>',
    '<div role="feed"><div role="article"><a href="/groups/vietseattle/posts/98/" aria-label="2h">2h</a><div data-ad-preview="message"><div dir="auto">Original post</div></div></div></div>',
  ], 'https://www.facebook.com/groups/vietseattle', true);
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0].text).toBe('Original post');
});
it('does not treat hydrated comment-only articles as original posts', async () => {
  const result = await fixture([
    '<div role="feed"><div role="article"></div><div role="article"></div></div>',
    '<div role="feed"><div role="article" aria-label="Comment by member"><a href="/groups/vietseattle/posts/88/">2h</a><div dir="auto">Visible reply</div></div><div role="article"></div></div>',
  ]);
  expect(result).toMatchObject({ status: 'partial_comments_only', posts: [] });
  expect((result as any).layout.commentArticlesSeen).toBeGreaterThan(0);
  expect((result as any).layout.commentLinksSeen).toBeGreaterThan(0);
  expect((result as any).layout.postLinksSeen).toBe(0);
});
it('captures linkless posts and only displayed comment and reaction statistics', async () => {
  const result = await fixture('<div role="feed"><div role="article"><div data-ad-preview="message">Community news</div><span>12 comments</span><span aria-label="25 reactions"></span><img alt="Like"><img alt="Love"><span aria-label="Like: 20"></span><ul><li>Private reply text</li></ul></div></div>');
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0]).toMatchObject({ text: 'Community news', commentCount: 12, reactions: { total: 25, kinds: ['Like', 'Love'], counts: { Like: 20 } } });
  expect(result.posts[0].permalink).toBeUndefined();
  expect(JSON.stringify(result.diagnostics)).toContain('Community news');
  expect(result.diagnostics?.articles[0].html).toContain('Private reply text');
  expect(result.diagnostics?.pageViews).toHaveLength(2);
  expect(result.diagnostics?.pageViews[0].feedHtml).toContain('role="feed"');
  expect(result.diagnostics?.samples[0]).toMatchObject({ rejection: 'candidate', hasUsablePostLink: false });
});
it('expands only original post messages as new cards scroll into view', async () => {
  const first = '<div role="feed"><div><div data-ad-preview="message">First… <div role="button">See more</div></div><div role="article" aria-label="Comment by member"><div data-ad-preview="message">Reply… <div role="button">See more</div></div></div><ul><li><div data-ad-preview="message">Another reply… <div role="button">See more</div></div></li></ul></div></div>';
  const second = '<div role="feed"><div><div data-ad-preview="message">Second… <div role="button">See more</div></div></div></div>';
  let replyClicks = 0;
  const result = await fixture([first, second], undefined, false, document => {
    for (const button of document.querySelectorAll('[role="button"]')) button.addEventListener('click', () => {
      if (button.closest('[role="article"]')) { replyClicks++; return; }
      button.closest('[data-ad-preview="message"]')!.textContent = button.closest('[role="feed"]')!.textContent!.includes('First') ? 'First full community post' : 'Second full community post';
    });
  });
  expect(result.posts.map(post => post.text)).toEqual(['First full community post', 'Second full community post']);
  expect(replyClicks).toBe(0);
});
it('reads visible action counts and per-reaction people labels without counting replies', async () => {
  const result = await fixture('<div role="feed"><div><div data-ad-preview="message">Community update</div><div role="button" aria-label="Like">28</div><div role="button" aria-label="Leave a comment">4</div><div role="button" aria-label="Like: 23 people"></div><div role="button" aria-label="Love: 3 people"></div><div role="article" aria-label="Comment by member"><div role="button" aria-label="Like">999</div><div role="button" aria-label="Leave a comment">999</div></div></div></div>');
  expect(result.posts[0]).toMatchObject({ commentCount: 4, reactions: { total: 28, kinds: ['Like', 'Love'], counts: { Like: 23, Love: 3 } } });
});
it('retains short post text', async () => {
  const result = await fixture('<div role="feed"><div role="article"><a href="/groups/vietseattle/posts/5/">time</a><div dir="auto">Hi</div></div></div>');
  expect(result.posts[0].text).toBe('Hi');
});
it('stops at the first older post without processing later cards or scrolling again', async () => {
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  const old = new Date(Date.now() - 9 * 86400000).toISOString();
  const article = (id: number, date: string) => `<div role="article"><a href="/groups/vietseattle/posts/${id}/">post</a><time datetime="${date}"></time><div dir="auto">Post ${id}</div></div>`;
  const result = await fixture([
    `<div role="feed">${article(1, recent)}</div>`,
    `<div role="feed">${article(2, recent)}${article(3, old)}${article(4, recent)}</div>`,
    `<div role="feed">${article(5, recent)}</div>`,
  ]);
  expect(result.status).toBe('partial_cutoff');
  expect(result.posts.map(post => post.text)).toEqual(['Post 1', 'Post 2']);
  expect(result.posts[0].publishedAt).toBe(recent);
  expect(result.diagnostics?.pageViews.map(view => view.scan)).toEqual([0, 1]);
  expect(result.diagnostics?.scans[1].olderItems).toBe(1);
});
it('parses relative post times and flags undated posts as unverified', async () => {
  const article = (id: number, label: string) => `<div role="article"><a aria-label="${label}" href="/groups/vietseattle/posts/${id}/">post</a><div dir="auto">Post ${id}</div></div>`;
  const result = await fixture(`<div role="feed">${article(2, '2h')}${article(3, 'unrecognized')}${article(1, '8d')}${article(4, '2h')}</div>`);
  expect(result.posts.map(post => post.text)).toEqual(['Post 2', 'Post 3']);
  expect(result.posts[0].publishedAt).toBeTruthy();
  expect(result.posts[1].publishedAt).toBeUndefined();
  expect(result.status).toBe('partial_unknown_time');
});
it('retains early posts when the rendered feed contains more than 120 articles', async () => {
  const html = Array.from({ length: 130 }, (_, index) => `<div role="article"><a aria-label="2h" href="/groups/vietseattle/posts/${index + 1}/">2h</a><div dir="auto">Post ${index + 1}</div></div>`).join('');
  const result = await fixture(`<div role="feed">${html}</div>`);
  expect(result.posts).toHaveLength(130);
  expect(result.posts[0].text).toBe('Post 1');
  expect(result.diagnostics?.articles).toHaveLength(120);
  expect(result.diagnostics?.articles[0].text).toContain('Post 1');
});
it('recognizes month-and-day calendar labels without a year', async () => {
  const label = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' }).format(new Date(Date.now() - 2 * 86400000));
  const result = await fixture(`<div role="feed"><div role="article"><a aria-label="${label} at 5:39 PM" href="/groups/vietseattle/posts/6/">post</a><div dir="auto">Calendar post</div></div></div>`);
  expect(result.posts[0].publishedAt).toBeTruthy();
});
it('collects readable public posts even when the page displays login fields', async () => {
  const result = await fixture('<input name="email"/><input name="pass"/><div role="feed"><div role="article"><a href="/groups/vietseattle/posts/123/" aria-label="2h">2h</a><div data-ad-preview="message">Public community post</div></div></div>');
  expect(result.posts).toHaveLength(1);
  expect(result.posts[0]).toMatchObject({ text: 'Public community post', permalink: 'https://www.facebook.com/groups/vietseattle/posts/123/' });
  expect(result.status).not.toBe('login_required');
  expect(result.diagnostics?.pageViews[0].feedHtml).toContain('Public community post');
});
it('waits for a public feed to hydrate despite visible login fields', async () => {
  const result = await fixture([
    '<input name="email"/><div role="feed"><div role="article"></div></div>',
    '<input name="email"/><div role="feed"><div role="article"><a href="/groups/vietseattle/posts/124/">2h</a><div dir="auto">Hydrated public post</div></div></div>',
  ]);
  expect(result.posts.map(post => post.text)).toEqual(['Hydrated public post']);
  expect(result.status).not.toBe('login_required');
});
it('reports unavailable layout or login without collecting content', async () => {
  const login = await fixture('<input name="email"/><div role="feed"></div>');
  expect(login.status).toBe('login_required');
  expect(login.diagnostics?.pageViews[0].feedHtml).toBe('');
  const missing = await fixture('<h1>Missing feed</h1>');
  expect(missing.status).toBe('layout_unsupported');
  expect(missing.diagnostics?.pageViews[0]).toMatchObject({ feedHtml: '', visibleText: 'Missing feed' });
  const redirect = await fixture('<h1>Sign in</h1>', 'https://www.facebook.com/login/');
  expect(redirect.diagnostics?.pageViews[0]).toMatchObject({ feedHtml: '', visibleText: 'Sign in' });
});
