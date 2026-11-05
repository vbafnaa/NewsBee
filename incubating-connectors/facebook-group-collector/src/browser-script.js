async (page, lookbackHours = 168, cutoffAt = null, firstTen = false, checkpointPath = null) => {
  const expected = new URL(page.url());
  if (expected.origin === 'https://www.facebook.com' && /^\/(?:login|checkpoint)(?:\/|$)/.test(expected.pathname)) {
    const visibleText = await page.evaluate(() => (document.body?.innerText || document.body?.textContent || '').slice(0, 8000));
    return { status: 'login_required', posts: [], diagnostics: { version: 1, scans: [], samples: [], pageViews: [{ scan: 0, feedHtml: '', visibleText }], articles: [] } };
  }
  if (expected.origin !== 'https://www.facebook.com' || !/^\/groups\/[a-zA-Z0-9._-]+\/?$/.test(expected.pathname)) throw new Error('unexpected_group_page');
  const slug = expected.pathname.split('/')[2].toLowerCase();
  const posts = new Map();
  const cutoff = cutoffAt ? Date.parse(cutoffAt) : Date.now() - lookbackHours * 60 * 60 * 1000;
  const maxPosts = firstTen ? 10 : 250;
  const maxScans = 44;
  let hadFeed = false;
  let noProgress = 0;
  let stalledScroll = 0;
  let stoppedAtCutoff = false;
  let reachedLimit = false;
  let commentOnly = false;
  let loginSeen = false;
  const layout = { scans: 0, feedSeen: 0, articlesSeen: 0, commentArticlesSeen: 0, commentLinksSeen: 0, postLinksSeen: 0, messageNodesSeen: 0, timeNodesSeen: 0, fallbackNodesSeen: 0 };
  const diagnostics = { version: 1, scans: [], samples: [], pageViews: [], articles: [] };
  const sampleSignatures = new Set();
  const articleSignatures = new Set();
  const seen = new Set();
  const hoverAttempts = new Map();
  const shareAttempts = new Map();
  await page.waitForFunction(() => !!document.querySelector('input[name="email"],input[name="pass"]') || !!document.querySelector('[role="feed"] [data-ad-preview="message"], [role="feed"] [data-ad-comet-preview="message"]') || [...document.querySelectorAll('[role="feed"] [role="article"]')].some(article => !!article.querySelector('a[href]') && !!(article.innerText || '').trim()), undefined, { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  function timestamp(item) {
    const absolute = Date.parse(item.publishedAt || '');
    if (Number.isFinite(absolute)) return absolute;
    const label = (item.rawTime || '').trim().toLowerCase();
    if (/^(just now|now|vừa xong)$/.test(label)) return Date.now();
    const yesterday = label.replace(/[\u00a0\u202f]/g, ' ').match(/^(?:yesterday|hôm qua)(?:\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?)?\b/);
    if (yesterday) {
      if (!yesterday[1]) return Date.now() - 24 * 60 * 60 * 1000;
      const hour = Number(yesterday[1]); const minute = Number(yesterday[2]);
      if (hour < 1 || hour > 12 || minute > 59) return NaN;
      const date = new Date();
      date.setDate(date.getDate() - 1);
      date.setHours(yesterday[3] ? hour % 12 + (yesterday[3] === 'pm' ? 12 : 0) : hour, minute, 0, 0);
      return date.getTime();
    }
    const relative = label.match(/^(\d+)\s*(minutes?|mins?|min|m|hours?|hrs?|hr|h|giờ|phút|days?|d|ngày|weeks?|w|tuần)(?:\s|$|ago|trước)/);
    if (relative) {
      const units = /^(m|min|phút)/.test(relative[2]) ? 60000 : /^(h|giờ)/.test(relative[2]) ? 3600000 : /^(d|ngày)/.test(relative[2]) ? 86400000 : 604800000;
      return Date.now() - Number(relative[1]) * units;
    }
    const calendar = label.replace(/\s+at\s+/g, ' ');
    if (/\b\d{4}\b/.test(calendar)) return Date.parse(calendar);
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/.test(calendar)) {
      const now = new Date();
      let parsed = Date.parse(`${calendar} ${now.getFullYear()}`);
      if (parsed > now.getTime() + 86400000) parsed = Date.parse(`${calendar} ${now.getFullYear() - 1}`);
      return parsed;
    }
    return NaN;
  }
  const expandCards = () => page.evaluate(() => {
      const messages = document.querySelectorAll('[role="feed"] [data-ad-preview="message"], [role="feed"] [data-ad-comet-preview="message"]');
      let clicked = 0;
      for (const message of messages) {
        if (message.closest('li,[role="listitem"]')) continue;
        const article = message.closest('[role="article"]');
        if (article && (/\bcomment\b|bình luận/i.test(article.getAttribute('aria-label') || '') || article.parentElement?.closest('[role="article"]'))) continue;
        for (const button of message.querySelectorAll('button,[role="button"]')) {
          if (!/^(See more|Xem thêm)$/i.test(button.textContent?.trim() || '') || !button.isConnected) continue;
          button.click();
          clicked++;
        }
      }
      const feed = document.querySelector('[role="feed"]');
      for (const card of [...(feed?.children || []), ...(feed?.querySelectorAll('[role="article"]') || [])]) {
        if (!card.querySelector('[dir="auto"]') || /\bcomment\b|bình luận/i.test(card.getAttribute('aria-label') || '')) continue;
        for (const button of card.querySelectorAll('button,[role="button"]')) {
          if (!/^(See more|Xem thêm)$/i.test(button.textContent?.trim() || '') || !button.isConnected ||
            (button.closest('[role="article"]') && button.closest('[role="article"]') !== card) ||
            button.closest('li,[role="listitem"],[data-ad-preview="message"],[data-ad-comet-preview="message"]')) continue;
          button.click();
          clicked++;
        }
      }
      return clicked;
    });
  for (let round = 0; round < maxScans; round++) {
    const expanded = await expandCards();
    if (expanded) await page.waitForTimeout(200);
    const scanFeed = () => page.evaluate(({ slug }) => {
      const feed = document.querySelector('[role="feed"]');
      const login = !!document.querySelector('input[name="email"],input[name="pass"]');
      const pageText = document.body?.innerText?.slice(0, 2000) || '';
      const challenge = /confirm your identity|security check|xác nhận danh tính/i.test(pageText);
      feed?.querySelectorAll('[data-newsbee-capture-index]').forEach(card => card.removeAttribute('data-newsbee-capture-index'));
      const articles = [...(feed?.querySelectorAll('[role="article"]') || [])].slice(-300);
      const commentArticles = articles.filter(article => /\bcomment\b|bình luận/i.test(article.getAttribute('aria-label') || ''));
      const postCards = [...(feed?.children || [])].filter(card => card.getAttribute('role') !== 'article' && (
        [...card.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]')]
          .some(el => !el.closest('[role="article"],li,[role="listitem"]') && (el.innerText || el.textContent || '').trim()) ||
        (card.querySelector('[role="article"][aria-label],a[href*="/groups/"]') &&
          [...card.querySelectorAll('[dir="auto"]')].some(el => !el.closest('[role="article"],a,button,[role="button"],li,header,[role="listitem"],blockquote') &&
            !el.querySelector('[dir="auto"]') && (el.innerText || el.textContent || '').trim()))));
      const owned = (el, root) => root.getAttribute('role') === 'article' ? el.closest('[role="article"]') === root : !el.closest('[role="article"]');
      const candidates = [...articles.filter(article => !commentArticles.includes(article) && !article.parentElement?.closest('[role="article"]')), ...postCards]
        .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1);
      const structure = { articlesSeen: articles.length, commentArticlesSeen: commentArticles.length,
        commentLinksSeen: articles.filter(article => /\bcomment\b|bình luận/i.test(article.getAttribute('aria-label') || '') && [...article.querySelectorAll('a[href]')].some(a => /\/groups\/[^/]+\/(?:posts|permalink)\/\d+\/?$/.test(a.href) && a.closest('[role="article"]') === article && !a.closest('li,[role="listitem"]'))).length,
        postLinksSeen: candidates.filter(article => [...article.querySelectorAll('a[href]')].some(a => /\/groups\/[^/]+\/(?:posts|permalink)\/\d+\/?$/.test(a.href) && owned(a, article) && !a.closest('li,[role="listitem"]'))).length,
        messageNodesSeen: candidates.filter(article => [...article.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]')].some(el => owned(el, article))).length,
        timeNodesSeen: candidates.filter(article => !!article.querySelector('time[datetime],abbr[data-utime]')).length,
        fallbackNodesSeen: candidates.filter(article => [...article.querySelectorAll('[dir="auto"]')].some(el => owned(el, article) && !el.closest('li,[role="listitem"]'))).length };
      const articleSamples = [...articles.slice(-60), ...postCards.slice(-20)].map(article => {
        const label = /\bcomment\b|bình luận/i.test(article.getAttribute('aria-label') || '') ? 'comment' : 'other';
        const links = [...article.querySelectorAll('a[href]')].filter(a => owned(a, article));
        const kinds = new Set();
        let hasUsablePostLink = false;
        let linkInList = false;
        for (const a of links) {
          try {
            const u = new URL(a.href);
            const isFacebook = ['www.facebook.com', 'facebook.com'].includes(u.hostname);
            if (isFacebook && /^\/groups\/[^/]+\/(?:posts|permalink)\/\d+\/?$/.test(u.pathname)) {
              kinds.add('numeric_post');
              if (u.pathname.split('/')[2].toLowerCase() === slug && !a.closest('li,[role="listitem"]')) hasUsablePostLink = true;
              if (a.closest('li,[role="listitem"]')) linkInList = true;
            } else if (isFacebook && /^\/groups\/[^/]+\/(?:posts|permalink)\//.test(u.pathname)) kinds.add('opaque_post');
            else if (isFacebook && u.pathname.startsWith('/groups/')) kinds.add('other_group');
            else if (isFacebook) kinds.add('other_facebook');
            else kinds.add('external');
          } catch { /* Invalid link is not included in the structural report. */ }
        }
        const message = [...article.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]')]
          .find(el => owned(el, article) && !el.closest('li,[role="listitem"]'));
        const fallback = [...article.querySelectorAll('[dir="auto"]')].filter(el =>
          owned(el, article) && !el.closest('a,button,[role="button"],li,header,[role="listitem"],blockquote') &&
          !el.querySelector('[dir="auto"]') && el.textContent?.trim());
        const hasText = (message ? [message] : fallback).some(el => {
          const text = (el.innerText || el.textContent || '').trim();
          return !!text && !/^(Like|Comment|Share|Thích|Bình luận|Chia sẻ|See more|Xem thêm)$/i.test(text);
        });
        return { label, nested: !!article.parentElement?.closest('[role="article"]'), hasText, linkKinds: [...kinds].slice(0, 5), hasUsablePostLink,
          linkInList, hasMessage: !!message, fallbackNodes: Math.min(fallback.length, 13500), hasTime: !!article.querySelector('time[datetime],abbr[data-utime]'),
          rejection: label === 'comment' ? 'comment_labeled' : article.parentElement?.closest('[role="article"]') ? 'nested_article' : !hasText ? 'missing_body' : 'candidate' };
      });
      const commentOnly = structure.commentArticlesSeen > 0;
      const items = candidates.map((article, captureIndex) => {
        article.setAttribute('data-newsbee-capture-index', String(captureIndex));
        const links = [...article.querySelectorAll('a[href]')].filter(a => owned(a, article) && !a.closest('li,[role="listitem"]'));
        const postPath = new RegExp('^/groups/' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(?:posts|permalink)/([0-9]+)/?$', 'i');
        const postId = a => {
          try { const u = new URL(a.href); return u.protocol === 'https:' && ['facebook.com', 'www.facebook.com'].includes(u.hostname) ? u.pathname.match(postPath)?.[1] : undefined; }
          catch { return undefined; }
        };
        const direct = links.find(a => postId(a) && !new URL(a.href).searchParams.has('comment_id'));
        const commentIds = [...new Set([...article.querySelectorAll('a[href*="comment_id"]')]
          .filter(a => { const owner = a.closest('li,[role="listitem"],[role="article"]'); return owner && owner !== article && article.contains(owner); })
          .map(postId).filter(Boolean))];
        const link = direct?.href || (commentIds.length === 1 ? `https://www.facebook.com/groups/${slug}/posts/${commentIds[0]}/` : undefined);
        const message = [...article.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]')]
          .find(el => owned(el, article) && !el.closest('li,[role="listitem"]'));
        const postNodes = message ? [message] : [...article.querySelectorAll('[dir="auto"]')].filter(el =>
          owned(el, article) && !el.closest('a,button,[role="button"],li,header,[role="listitem"],blockquote') &&
          !el.querySelector('[dir="auto"]') && el.textContent?.trim()
        );
        const text = postNodes.map(el => (el.innerText || el.textContent || '').trim().replace(/\s*(?:See less|Xem bớt)$/i, ''))
          .filter(t => t && !/^(Like|Comment|Share|Thích|Bình luận|Chia sẻ|See more|Xem thêm)$/i.test(t))
          .join('\n').slice(0, 12000);
        const parseCount = value => {
          const match = value.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
          return match ? Math.min(1000000000, Math.round(Number(match[1]) * (match[2]?.toLowerCase() === 'k' ? 1000 : match[2]?.toLowerCase() === 'm' ? 1000000 : 1))) : undefined;
        };
        const labels = [...article.querySelectorAll('[aria-label],[title],a,span,img[alt],[role="button"]')]
          .filter(el => owned(el, article) && !el.closest('li,[role="listitem"]') && !message?.contains(el)).slice(0, 300);
        const reactionNames = { like: 'Like', love: 'Love', care: 'Care', haha: 'Haha', wow: 'Wow', sad: 'Sad', angry: 'Angry', thích: 'Like', 'yêu thích': 'Love', 'thương thương': 'Care', buồn: 'Sad', 'phẫn nộ': 'Angry' };
        const reactionKinds = new Set();
        const reactionCounts = {};
        let commentCount;
        let reactionTotal;
        for (const el of labels) {
          const values = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt'),
            el.children.length === 0 ? el.textContent : ''].filter(Boolean).map(value => value.trim());
          const buttonLabel = el.getAttribute('aria-label') || '';
          if (el.getAttribute('role') === 'button') {
            const displayed = parseCount((el.innerText || el.textContent || '').trim());
            if (displayed !== undefined) {
              if (/^Leave a comment$/i.test(buttonLabel)) commentCount = Math.max(commentCount || 0, displayed);
              if (/^Like$/i.test(buttonLabel)) reactionTotal = Math.max(reactionTotal || 0, displayed);
            }
          }
          for (const value of values) {
            const comments = value.match(/^(?:view all\s+)?([\d.,]+[kKmM]?)\s+(?:comments?|bình luận)$/i);
            if (comments) { const count = parseCount(comments[1]); if (count !== undefined) commentCount = Math.max(commentCount || 0, count); }
            const total = value.match(/^([\d.,]+[kKmM]?)\s+(?:reactions?|lượt cảm xúc)$/i);
            if (total) { const count = parseCount(total[1]); if (count !== undefined) reactionTotal = Math.max(reactionTotal || 0, count); }
            const named = value.match(/^(like|love|care|haha|wow|sad|angry|thích|yêu thích|thương thương|buồn|phẫn nộ)(?::\s*([\d.,]+[kKmM]?)(?:\s+people?)?)?$/i);
            if (named && (el.tagName === 'IMG' || named[2])) {
              const kind = reactionNames[named[1].toLowerCase()];
              reactionKinds.add(kind);
              if (named[2]) { const count = parseCount(named[2]); if (count !== undefined) reactionCounts[kind] = Math.max(reactionCounts[kind] || 0, count); }
            }
          }
        }
        const isPostTime = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent?.trim()].some(value => /^(?:\d+\s*(?:s|m|h|d|w|y|mins?|hours?|days?|weeks?|years?|giờ|phút|ngày|tuần)(?:\s+ago)?|just now|now|yesterday(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM))?|hôm qua|(?:[A-Z][a-z]+,?\s+)?[A-Z][a-z]+\s+\d{1,2}(?:,?\s+\d{4})?(?:\s+at\s+.+)?)$/i.test(value || ''));
        const timeAnchor = links.find(a => /\/groups\/[^/]+\/(?:posts|permalink)\//.test(new URL(a.href).pathname) && !new URL(a.href).searchParams.has('comment_id') && isPostTime(a)) ||
          links.find(a => isPostTime(a) && !new URL(a.href).searchParams.has('comment_id') && !message?.contains(a));
        const dateNode = [...article.querySelectorAll('time[datetime],abbr[data-utime]')].find(el => owned(el, article) && !el.closest('li,[role="listitem"]') && !message?.contains(el));
        const labeledTime = [...article.querySelectorAll('a[role="link"] [aria-labelledby]')].filter(el =>
          owned(el, article) && !el.closest('li,[role="listitem"],blockquote') && !message?.contains(el) &&
          (!postNodes[0] || !!(el.compareDocumentPosition(postNodes[0]) & 4)))
          .map(el => {
            const id = el.getAttribute('aria-labelledby')?.trim();
            const label = id && !/\s/.test(id) ? document.getElementById(id) : null;
            return label && (!label.closest('[role="article"]') || (article.contains(label) && owned(label, article))) &&
              !label.closest('li,[role="listitem"]') && !message?.contains(label) && isPostTime(label)
              ? label.textContent?.trim() : undefined;
          }).find(Boolean);
        const glyphTime = links.filter(a => a.getAttribute('role') === 'link' &&
          /^\/groups\/[^/]+(?:\/posts\/\d+\/?|\/?)$/.test(new URL(a.href).pathname) &&
          !new URL(a.href).searchParams.has('comment_id') && !message?.contains(a) &&
          (!postNodes[0] || !!(a.compareDocumentPosition(postNodes[0]) & 4)))
          .map(a => {
            const glyphs = [...a.querySelectorAll('span')].filter(el => !el.children.length && (el.textContent || '').length <= 4);
            if (glyphs.length < 6) return undefined;
            const visible = glyphs.filter(el => getComputedStyle(el).position === 'relative')
              .map(el => ({ text: el.textContent || '', rect: el.getBoundingClientRect() }))
              .filter(part => part.rect.width > 0 && part.rect.height > 0);
            if (!visible.length) return undefined;
            visible.sort((a, b) => Math.abs(a.rect.top - b.rect.top) < 4 ? a.rect.left - b.rect.left : a.rect.top - b.rect.top);
            const value = visible.map(part => part.text).join('').replace(/[\u034f\u200c\u200d]/g, '').replace(/[\u00a0\u202f]/g, ' ').trim();
            return isPostTime({ getAttribute: () => null, textContent: value }) ? value : undefined;
          }).find(Boolean);
        const headerTime = [...article.querySelectorAll('span,[role="time"]')].find(el =>
          owned(el, article) && !el.closest('li,[role="listitem"],button,[role="button"],blockquote,[data-ad-preview="message"],[data-ad-comet-preview="message"]') &&
          !el.querySelector('span,[role="time"]') && isPostTime(el) &&
          (!postNodes[0] || !!(el.compareDocumentPosition(postNodes[0]) & 4)));
        const rawTime = timeAnchor?.getAttribute('aria-label') || timeAnchor?.getAttribute('title') || dateNode?.getAttribute('title') || timeAnchor?.textContent?.trim() ||
          labeledTime || glyphTime || headerTime?.getAttribute('aria-label') || headerTime?.getAttribute('title') || headerTime?.textContent?.trim() || undefined;
        const epoch = Number(dateNode?.getAttribute('data-utime')) * 1000;
        const publishedAt = dateNode?.getAttribute('datetime') || (Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : undefined);
        const sourceLinks = links.map(a => a.href).filter(h => {
          try { const u = new URL(h); return u.protocol === 'https:' && !u.hostname.endsWith('facebook.com') && !u.hostname.endsWith('fb.com'); } catch { return false; }
        }).slice(0, 12);
        return { permalink: link, text, commentCount, reactions: { total: reactionTotal, kinds: [...reactionKinds], counts: reactionCounts }, contentVerified: !!message || (article.getAttribute('role') !== 'article' && !!text), rawTime, publishedAt, sourceLinks, truncated: /See more|Xem thêm/.test(message?.innerText || message?.textContent || text), captureIndex };
      }).filter(Boolean);
      const rawArticles = [...new Set([...articles.slice(0, 60), ...articles.slice(-60), ...postCards.slice(0, 20)])].map(article => ({
        label: /\bcomment\b|bình luận/i.test(article.getAttribute('aria-label') || '') ? 'comment' : 'other',
        text: (article.innerText || article.textContent || '').slice(0, 1000), html: article.outerHTML.slice(0, 2000),
      }));
      const pageView = { feedHtml: challenge || (login && !items.some(item => item.text)) ? '' : (feed?.outerHTML || '').slice(0, 32000), visibleText: (feed?.innerText || feed?.textContent || document.body?.innerText || document.body?.textContent || '').slice(0, 8000) };
      return { feed: !!feed, login, challenge, commentOnly, structure, articleSamples, rawArticles, pageView, outsideFeedArticles: Math.max(0, document.querySelectorAll('[role="article"]').length - (feed?.querySelectorAll('[role="article"]').length || 0)), items };
    }, { slug });
    let scan = await scanFeed();
    const truncatedBeforeRetry = scan.items.filter(item => item.truncated).length;
    let expandedLate = 0;
    if (truncatedBeforeRetry) {
      expandedLate = await expandCards();
      if (expandedLate || expanded) {
        await page.waitForTimeout(500);
        scan = await scanFeed();
      }
    }
    if (round === 0 && scan.items.some(item => item.text && !Number.isFinite(timestamp(item)))) {
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.waitForTimeout(1000);
        const hydrated = await scanFeed();
        scan = hydrated;
        if (hydrated.challenge || hydrated.items.some(item => item.text && Number.isFinite(timestamp(item)))) break;
      }
    }
    if (scan.challenge) return { status: 'login_required', posts: [], diagnostics: { ...diagnostics, pageViews: [{ scan: round, ...scan.pageView }] } };
    if (scan.login) loginSeen = true;
    const initialUndatedHtml = await page.evaluate(indices => Object.fromEntries(indices.map(index => {
      const card = document.querySelector(`[data-newsbee-capture-index="${index}"]`);
      return [index, card?.outerHTML.slice(0, 250000)];
    })), scan.items.filter(item => item.text && !Number.isFinite(timestamp(item))).map(item => item.captureIndex));
    const scanScrollY = await page.evaluate(() => window.scrollY);
    for (const item of [...scan.items].reverse()) {
      if (!item.text || Number.isFinite(timestamp(item))) continue;
      const hoverKey = item.permalink ? new URL(item.permalink).pathname : `body:${item.text}`;
      const attempts = hoverAttempts.get(hoverKey) || 0;
      if (attempts >= 2) continue;
      hoverAttempts.set(hoverKey, attempts + 1);
      try {
        const selector = `[data-newsbee-capture-index="${item.captureIndex}"]`;
        const cardVisible = await page.evaluate(selector => {
          const card = document.querySelector(selector);
          card?.scrollIntoView({ block: 'center' });
          return !!card;
        }, selector);
        if (!cardVisible) continue;
        let hasTimeLink = false;
        for (let attempt = 0; attempt < 4 && !hasTimeLink; attempt++) {
          await page.waitForTimeout(250);
          hasTimeLink = await page.evaluate(({ selector, slug }) => {
          const card = document.querySelector(selector);
          const body = card?.querySelector('[data-ad-preview="message"],[data-ad-comet-preview="message"]');
          const timeLink = [...(card?.querySelectorAll('a[href]:has(svg use)') || [])].find(link => {
            const href = link.getAttribute('href') || '';
            const url = new URL(href, document.baseURI);
            const segments = url.pathname.split('/').filter(Boolean);
            const originalPost = url.hostname === 'www.facebook.com' &&
              segments.length === 4 && segments[0] === 'groups' && segments[1] === slug &&
              ['posts', 'permalink'].includes(segments[2]) && /^\d+$/.test(segments[3]) &&
              !url.searchParams.has('comment_id');
            return (href.startsWith('?') || originalPost) &&
              !link.textContent?.trim() && link.style.display === 'inline-block' &&
              !link.closest('li,[role="listitem"]') &&
              (card.getAttribute('role') === 'article' ? link.closest('[role="article"]') === card : !link.closest('[role="article"]')) &&
              (!body || !!(link.compareDocumentPosition(body) & 4));
          });
          if (!timeLink) return false;
          timeLink.setAttribute('data-newsbee-time-link', '');
          timeLink.scrollIntoView({ block: 'center' });
          return true;
          }, { selector, slug });
        }
        if (!hasTimeLink) continue;
        const points = await page.evaluate(() => {
          const link = document.querySelector('[data-newsbee-time-link]');
          const rect = link?.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0 || rect.y < 0 || rect.y >= window.innerHeight) return [];
          const y = rect.y + Math.min(rect.height / 2, 10);
          const candidates = [rect.x + rect.width / 2, rect.x + Math.min(12, rect.width / 2), rect.x + rect.width - Math.min(12, rect.width / 2)]
            .map(x => ({ x, y }));
          return candidates.filter(point => !document.elementFromPoint || link.contains(document.elementFromPoint(point.x, point.y)));
        });
        const tooltipTime = async () => {
          const labels = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')]
            .filter(el => el.getBoundingClientRect().width > 0)
            .map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean));
          return labels.find(label => Number.isFinite(timestamp({ rawTime: label })));
        };
        for (const point of points) {
          await page.mouse.move(0, 0);
          await page.mouse.move(point.x, point.y);
          await page.waitForTimeout(650);
          const hovered = await tooltipTime();
          if (hovered) { item.rawTime = hovered; break; }
        }
        if (!item.rawTime) {
          await page.mouse.move(0, 0);
          await page.locator('[data-newsbee-time-link]').hover({ force: true, timeout: 1500 });
          await page.waitForTimeout(650);
          item.rawTime = await tooltipTime();
        }
      } catch { /* A missing tooltip must not interrupt the feed scan. */ }
      finally { await page.evaluate(() => document.querySelectorAll('[data-newsbee-time-link]').forEach(el => el.removeAttribute('data-newsbee-time-link'))).catch(() => undefined); }
    }
    await page.evaluate(y => window.scrollTo(0, y), scanScrollY);
    for (const item of scan.items) {
      if (!firstTen && timestamp(item) < cutoff) break;
      if (item.permalink || !item.text || (shareAttempts.get(item.text) || 0) >= 3 ||
        [...posts.values()].some(post => post.permalink && post.text === item.text)) continue;
      shareAttempts.set(item.text, (shareAttempts.get(item.text) || 0) + 1);
      let openedShare = false;
      try {
        openedShare = await page.evaluate(index => {
          const card = document.querySelector(`[data-newsbee-capture-index="${index}"]`);
          const share = [...(card?.querySelectorAll('[aria-label^="Share, send this"]') || [])].find(el =>
            (card.getAttribute('role') === 'article' ? el.closest('[role="article"]') === card : !el.closest('[role="article"]')) &&
            !el.closest('li,[role="listitem"]'));
          if (!share) return false;
          share.click();
          return true;
        }, item.captureIndex);
        if (!openedShare) continue;
        let shareUrl;
        for (let attempt = 0; attempt < 6 && !shareUrl; attempt++) {
          await page.waitForTimeout(300);
          shareUrl = await page.evaluate(() => {
            const dialog = [...document.querySelectorAll('[role="dialog"]')].find(el => el.getBoundingClientRect().width > 0);
            const links = [...(dialog?.querySelectorAll('a[href*="/l.php"]') || [])].map(a => {
              try {
                const redirect = new URL(a.href);
                if (!['https://www.facebook.com', 'https://l.facebook.com'].includes(redirect.origin) || redirect.pathname !== '/l.php') return undefined;
                const destination = new URL(redirect.searchParams.get('u'));
                if (destination.origin !== 'https://wa.me') return undefined;
                const share = new URL(destination.searchParams.get('text'));
                return share.origin === 'https://www.facebook.com' && /^\/share\/p\/[a-zA-Z0-9_-]+\/$/.test(share.pathname) ? share.href : undefined;
              } catch { return undefined; }
            }).filter(Boolean);
            return [...new Set(links)].length === 1 ? links[0] : undefined;
          });
        }
        if (shareUrl) {
          const tab = await page.context().newPage();
          try {
            await tab.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
            const target = new URL(tab.url());
            const match = target.origin === 'https://www.facebook.com' && target.pathname.match(new RegExp(`^/groups/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:posts|permalink)/(\\d+)/?$`, 'i'));
            if (match) item.permalink = `https://www.facebook.com/groups/${slug}/posts/${match[1]}/`;
          } finally { await tab.close(); }
        }
      } catch { /* Unavailable sharing controls must not discard the captured post. */ }
      finally { if (openedShare) await page.keyboard?.press('Escape').catch(() => undefined); }
    }
    const view = { scan: round, ...scan.pageView };
    if (round === 0) diagnostics.pageViews.push(view);
    else diagnostics.pageViews[1] = view;
    for (const article of scan.rawArticles) {
      if (diagnostics.articles.length >= 120) break;
      const signature = JSON.stringify(article);
      if (articleSignatures.has(signature)) continue;
      articleSignatures.add(signature);
      diagnostics.articles.push({ scan: round, ...article });
    }
    layout.scans++;
    if (scan.feed) { hadFeed = true; layout.feedSeen++; }
    for (const key of ['articlesSeen', 'commentArticlesSeen', 'commentLinksSeen', 'postLinksSeen', 'messageNodesSeen', 'timeNodesSeen', 'fallbackNodesSeen']) layout[key] = Math.min(13500, layout[key] + scan.structure[key]);
    if (scan.commentOnly) commentOnly = true;
    let newItems = 0;
    let recent = 0;
    let older = 0;
    const undated = [];
    for (const item of scan.items) {
      if (!item.text) continue;
      const bodyKey = `body:${item.text}`;
      const key = item.permalink ? new URL(item.permalink).pathname : [...posts.entries()].find(([, post]) => post.permalink && post.text === item.text)?.[0] || bodyKey;
      const date = timestamp(item);
      if (!firstTen && Number.isFinite(date) && date < cutoff) { older++; stoppedAtCutoff = true; break; }
      if (item.permalink && seen.has(bodyKey) && !seen.has(key)) {
        const previous = posts.get(bodyKey);
        if (previous && !previous.permalink) {
          posts.delete(bodyKey); seen.delete(bodyKey);
          posts.set(key, { ...previous, permalink: item.permalink }); seen.add(key);
        }
      }
      if (seen.has(key)) {
        const previous = posts.get(key);
        if (previous) {
          posts.set(key, { ...previous, rawTime: previous.rawTime ?? item.rawTime,
            publishedAt: previous.publishedAt ?? (Number.isFinite(date) ? new Date(date).toISOString() : undefined),
            postHtml: previous.publishedAt || Number.isFinite(date) ? undefined : previous.postHtml,
            commentCount: item.commentCount ?? previous.commentCount, reactions: { total: item.reactions?.total ?? previous.reactions?.total, kinds: item.reactions?.kinds?.length ? item.reactions.kinds : previous.reactions?.kinds || [], counts: { ...previous.reactions?.counts, ...item.reactions?.counts } } });
        }
        continue;
      }
      seen.add(key);
      newItems++;
      if (Number.isFinite(date)) { item.publishedAt = new Date(date).toISOString(); recent++; }
      posts.set(key, item);
      if (!item.publishedAt) undated.push({ key, index: item.captureIndex });
      if (posts.size >= maxPosts) break;
    }
    if (undated.length) {
      try {
        const htmlByIndex = await page.evaluate(indices => Object.fromEntries(indices.map(index => {
          const card = document.querySelector(`[data-newsbee-capture-index="${index}"]`);
          return [index, card?.outerHTML];
        })), undated.map(item => item.index));
        for (const { key, index } of undated) {
          const post = posts.get(key);
          const html = initialUndatedHtml[index];
          if (post && !post.publishedAt && (html || htmlByIndex[index])) post.postHtml = html && html.length >= (htmlByIndex[index]?.length || 0) ? html : htmlByIndex[index];
        }
      } catch { /* A detached card must not prevent the rest of the run from being saved. */ }
    }
    diagnostics.scans.push({ scan: round, feed: scan.feed, articles: scan.structure.articlesSeen,
      outsideFeedArticles: Math.min(scan.outsideFeedArticles, 13500), commentArticles: scan.structure.commentArticlesSeen,
      commentLinks: scan.structure.commentLinksSeen, postLinks: scan.structure.postLinksSeen,
      messageNodes: scan.structure.messageNodesSeen, fallbackNodes: scan.structure.fallbackNodesSeen,
      candidateItems: scan.items.length, newItems, recentItems: recent, olderItems: older,
      expandedButtons: expanded + expandedLate, truncatedBeforeRetry, truncatedAfterRetry: scan.items.filter(item => item.truncated).length });
    for (const sample of scan.articleSamples) {
      const signature = JSON.stringify(sample);
      if (sampleSignatures.has(signature) || diagnostics.samples.length >= 24) continue;
      sampleSignatures.add(signature);
      diagnostics.samples.push({ scan: round, ...sample });
    }
    if (checkpointPath) {
      try {
        await fetch(checkpointPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: [...posts.values()], layout, diagnostics }) });
      } catch { /* A checkpoint failure must not interrupt collection. */ }
    }
    noProgress = newItems === 0 ? noProgress + 1 : 0;
    if (stoppedAtCutoff) break;
    if (posts.size >= maxPosts) { reachedLimit = !firstTen; break; }
    if (round === maxScans - 1) { reachedLimit = true; break; }
    if (!scan.feed || noProgress >= 10 || (noProgress >= (firstTen ? 5 : 3) && stalledScroll >= 2)) break;
    const moved = await page.evaluate(() => {
      const before = window.scrollY;
      window.scrollBy(0, Math.max(window.innerHeight, 750));
      return window.scrollY > before + 1;
    });
    stalledScroll = moved ? 0 : stalledScroll + 1;
    await page.waitForTimeout(700);
  }
  if (loginSeen && posts.size === 0) return { status: 'login_required', posts: [], layout, diagnostics };
  const emptyPlaceholders = layout.articlesSeen > 0 && !layout.commentArticlesSeen && !layout.postLinksSeen && !layout.messageNodesSeen && !layout.fallbackNodesSeen;
  const status = !hadFeed ? 'layout_unsupported' : posts.size === 0 ? commentOnly ? 'partial_comments_only' : emptyPlaceholders ? 'partial_feed_unloaded' : 'partial_no_posts' : reachedLimit ? 'partial_limit' : firstTen && posts.size < maxPosts ? 'partial_fewer_posts' : [...posts.values()].some(item => !item.publishedAt) ? 'partial_unknown_time' : stoppedAtCutoff ? 'partial_cutoff' : 'partial_feed';
  return { status, posts: [...posts.values()], layout, diagnostics };
}
