#!/usr/bin/env node
/**
 * Clicks through the journalist workspace in a real browser: from every journalist page, a real mouse
 * click on each sidebar link, the bell, the brand and each ⋯ menu link must move the URL there. Playwright
 * refuses a click when something else covers the target, so an invisible overlay fails it too.
 *
 *   node scripts/check-newsroom-navigation.mjs [origin] [newsroom id]
 *
 * Needs a local stack (`npm run local`) and Playwright, which this repository doesn't install: point
 * NEWSBEE_PLAYWRIGHT at a Playwright module if `playwright` isn't resolvable. Signs in through the local role
 * switcher, so it only runs against localhost.
 */
const origin = process.argv[2] ?? "http://localhost:3000";
const newsroom = process.argv[3] ?? "a".repeat(32);
const roles = (process.env.NEWSBEE_NAV_ROLES ?? "editor-a,owner").split(",");
const { chromium } = await import(process.env.NEWSBEE_PLAYWRIGHT ?? "playwright").catch(() => {
  console.error("Playwright isn't installed. Install it, or set NEWSBEE_PLAYWRIGHT to a Playwright module path.");
  process.exit(2);
});

const base = `/newsroom/${newsroom}`;
const TARGETS = ".jw-nav a[href], .jw-topbar a[href], a.jw-brand, .jw-user-menu-panel a[href]";

const browser = await chromium.launch();
const failures = [];
let clicks = 0;
for (const role of roles) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${origin}/api/local-role?as=${role}&returnTo=${encodeURIComponent(base)}`, { waitUntil: "networkidle" });
  // Every journalist page: each sidebar destination, plus the inbox and settings.
  const pages = [...new Set([base, ...await page.locator(".jw-nav a[href]").evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
    `${base}/inbox`, `${base}/settings`])].filter((href) => href.startsWith(base));
  for (const start of pages) {
    await page.goto(origin + start, { waitUntil: "networkidle" });
    const from = new URL(page.url()).pathname;
    const hrefs = [...new Set(await page.locator(TARGETS).evaluateAll((links) => links.map((link) => link.getAttribute("href"))))]
      .filter((href) => href !== from);
    for (const href of hrefs) {
      await page.goto(origin + start, { waitUntil: "networkidle" });
      const link = page.locator(TARGETS).and(page.locator(`[href="${href}"]`)).first();
      if (await link.evaluate((element) => Boolean(element.closest(".jw-user-menu-panel")))) await page.locator(".jw-user-menu summary").click();
      const began = Date.now();
      try {
        await link.click({ timeout: 5000 });
        await page.waitForURL((url) => url.pathname !== from, { timeout: 30000 });
        clicks += 1;
        console.log(`${role} ${start.slice(base.length) || "/"} → ${href.replace(base, "") || "/"} ${Date.now() - began} ms`);
      } catch (error) {
        failures.push(`${role}: ${start} → ${href}: ${error.message.split("\n")[0]}`);
      }
    }
  }
  await page.close();
}
await browser.close();
console.log(`${clicks} navigations passed, ${failures.length} failed`);
for (const failure of failures) console.error(failure);
process.exit(failures.length ? 1 : 0);
