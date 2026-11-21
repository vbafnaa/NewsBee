import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { test } from "node:test";

// Dependency-free browser check: node --test pipeline/tests/workspace/item24-geometry.test.mjs
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const browser = process.env.NEWSBEE_TEST_BROWSER
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseline = "d2492002222eabac79249c4a5812090fc97ceaba";
const stylesPath = "apps/journalist-site/app/styles.css";

function fixture(tokens, styles) {
  const sourceRow = (type) => `<div class="editorial-source">
    <select aria-label="Source type"><option>${type}</option></select>
    <input aria-label="Source name" value="Local reporting source">
    ${["Web", "Document"].includes(type) ? '<input aria-label="Source URL" type="url" value="https://example.test/original-reporting">' : ""}
    <input aria-label="Source note" value="Context or verification note">
  </div>`;
  return `<!doctype html><meta charset="utf-8"><style>${tokens}\n${styles}</style>
    <main class="admin-shell portal-shell"><aside class="sidebar">Newsbee
    <nav class="portal-primary-nav"><a class="sidebar-link">Overview</a><a class="sidebar-link">Publications</a>
    <details class="operator-links" open><summary>Operator tools</summary>
    <a class="sidebar-link" href="#settings">API settings</a><a class="sidebar-link" href="#clear">Clear data</a>
    </details></nav></aside>
    <section class="admin-content"><section class="panel editorial-story-panel">
    <article class="editorial-story"><div class="editorial-story-fields">
      <label>Headline<input value="Original reporting"></label>
      <label>Story body<textarea rows="8">Original reporting body</textarea></label>
      <fieldset><legend>Locations</legend>
        <label><input type="checkbox" checked> Bainbridge</label>
        <label><input type="radio" checked> Selected location</label>
      </fieldset>
      <fieldset><legend>Original story sources</legend>
        ${["Web", "Document", "Interview", "Observation"].map(sourceRow).join("")}
      </fieldset>
    </div><aside class="editorial-story-evidence"><h4>Original reporting</h4>Evidence</aside>
    </article><button class="danger">Delete publication</button>
    <button class="danger" disabled>Delete publication</button>
    <button class="secondary">Keep publication</button>
    </section><section class="panel campaign-results"><div class="campaign-lead-list">
    <article class="campaign-lead-card"><div class="campaign-lead-summary">
      <h3>long.campaign.contact@example.test</h3><p>Bainbridge community reporting campaign</p>
      <p><time>November 17, 2026</time></p>
    </div><dl class="campaign-lead-context"><div><dt>Location</dt><dd>Bainbridge, WA</dd></div>
    <div><dt>Context</dt><dd>Original local reporting and newsletter updates</dd></div></dl>
    <details class="campaign-attribution" open><summary>Attribution</summary><dl><div><dt>Source</dt>
      <dd>https://example.test/a-long-campaign-path-with-additional-attribution-context</dd>
    </div></dl>    </details></article></div></section>
    <section class="panel admin-readiness-queue"><ol class="location-directory-list">
      <li class="location-directory-row"><div class="location-directory-copy">
        <h3>Synthetic community: https://example.test/${"longsource".repeat(24)} is blocked</h3>
        <p>Pause or reject it, or ask the site for a feed.</p>
      </div><div class="location-directory-actions"><a class="button secondary">Review</a></div></li>
    </ol></section></section></main>`;
}

test("item24 nested source fields and semantic controls", { skip: !existsSync(browser), timeout: 60000 }, async (t) => {
  const [tokens, styles] = await Promise.all([
    readFile(resolve(root, "shared", "design-tokens.css"), "utf8"),
    readFile(resolve(root, ...stylesPath.split("/")), "utf8"),
  ]);
  const oldStyles = execFileSync("git", ["show", `${baseline}:${stylesPath}`], { cwd: root, encoding: "utf8" });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixture(tokens, request.url === "/baseline" ? oldStyles : styles));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const profile = resolve(root, `.item24-browser-${process.pid}`);
  await mkdir(profile);
  const child = spawn(browser, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let socket;
  const pending = new Map();
  let id = 0;
  try {
    const endpoint = await new Promise((done, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Browser debugging endpoint timed out")), 15000);
      child.once("error", reject);
      child.stderr.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); done(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
    });
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => call(method, params, sessionId);
    const evaluate = async (expression) => {
      const result = await page("Runtime.evaluate", { expression, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const navigate = async (path, width) => {
      await page("Emulation.setDeviceMetricsOverride", { width, height: 1100, deviceScaleFactor: 1, mobile: false });
      await page("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/${path}` });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate('document.readyState === "complete" && !!document.querySelector(".editorial-source")')) return;
        await new Promise((done) => setTimeout(done, 20));
      }
      assert.fail("Fixture did not load");
    };
    const geometry = () => evaluate(`(() => {
      const story = document.querySelector(".editorial-story").getBoundingClientRect();
      const fields = document.querySelector(".editorial-story-fields").getBoundingClientRect();
      return [...document.querySelectorAll(".editorial-source input, .editorial-source select")].map(el => {
        el.focus();
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        const fieldset = el.closest("fieldset").getBoundingClientRect();
        const clips = [...function* () { for (let p = el.parentElement; p; p = p.parentElement) yield p; }()]
          .filter(p => ["hidden", "clip", "auto", "scroll"].includes(getComputedStyle(p).overflowX))
          .some(p => { const r = p.getBoundingClientRect(); return box.left - ring < r.left || box.right + ring > r.right; });
        return { label: el.getAttribute("aria-label"), width: box.width, height: box.height,
          contained: box.left >= fieldset.left && box.right <= fieldset.right + 1
            && box.left >= fields.left && box.right <= fields.right + 1
            && box.left >= story.left && box.right <= story.right + 1,
          clips, ring, fontSize: style.fontSize };
      });
    })()`);
    await navigate("baseline", 768);
    const before = await geometry();
    assert.ok(before.some((field) => !field.contained || field.clips), "Baseline must reproduce nested source clipping");
    t.diagnostic(`baseline 768px: ${before.filter((field) => !field.contained || field.clips).length}/${before.length} fields overflow or clip focus`);
    for (const width of [761, 768, 1024, 1280]) {
      await navigate("current", width);
      const after = await geometry();
      assert.equal(after.length, 14);
      for (const field of after) {
        assert.ok(field.contained && !field.clips, `${width}px ${JSON.stringify(field)}`);
        assert.ok(field.height >= 44 && field.width >= 160, `${width}px ${JSON.stringify(field)}`);
        assert.equal(field.fontSize, "16px");
        assert.ok(field.ring >= 4, "Focused source field must retain a visible outline");
      }
      t.diagnostic(`${width}px: all 14 source controls and focus outlines fit their nested containers`);
    }
    const controls = await evaluate(`(() => {
      const read = selector => { const el = document.querySelector(selector); const s = getComputedStyle(el);
        return { width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
          color: s.color, background: s.backgroundColor, border: s.borderStyle, decoration: s.textDecorationLine }; };
      return { check: read('[type="checkbox"]'), radio: read('[type="radio"]'),
        textarea: read("textarea"), danger: read("button.danger"), disabled: read("button.danger:disabled") };
    })()`);
    assert.equal(controls.check.width, 20);
    assert.equal(controls.radio.width, 20);
    assert.ok(controls.textarea.height > 100, "Rows must continue to control textarea height");
    assert.equal(controls.danger.color, "rgb(138, 29, 21)");
    assert.equal(controls.danger.background, "rgb(255, 245, 243)");
    assert.equal(controls.danger.decoration, "underline");
    assert.equal(controls.disabled.border, "dashed");
    await page("DOM.enable");
    await page("CSS.enable");
    const { root: documentNode } = await page("DOM.getDocument");
    const { nodeId } = await page("DOM.querySelector", { nodeId: documentNode.nodeId, selector: "button.danger" });
    await page("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover", "focus-visible"] });
    await new Promise((done) => setTimeout(done, 200));
    assert.deepEqual(await evaluate(`(() => { const s = getComputedStyle(document.querySelector("button.danger")); return [s.backgroundColor, s.color, s.outlineWidth]; })()`),
      ["rgb(251, 232, 229)", "rgb(138, 29, 21)", "3px"]);
    await navigate("current", 390);
    assert.ok(await evaluate(`(() => {
      const nav = document.querySelector(".portal-primary-nav");
      const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
      return [...document.querySelectorAll(".operator-links .sidebar-link")].every(el => {
        el.focus();
        const r = el.getBoundingClientRect();
        return r.height >= 44 && r.left >= sidebar.left && r.right <= sidebar.right
          && r.bottom <= sidebar.bottom && nav.scrollWidth <= nav.clientWidth;
      });
    })()`), "Opened mobile operator tools must be visible without horizontal panning");
    assert.ok(await evaluate(`(() => {
      const card = document.querySelector(".campaign-lead-card");
      const bounds = card.getBoundingClientRect();
      return card.scrollWidth <= card.clientWidth && [...card.querySelectorAll("h3, p, dt, dd, summary")].every(el => {
        const r = el.getBoundingClientRect();
        return r.left >= bounds.left && r.right <= bounds.right && r.width > 0 && r.height > 0
          && getComputedStyle(el).visibility === "visible";
      });
    })()`), "Campaign identity, campaign, date, context and attribution must fit without panning");
    for (const width of [374, 390, 768, 1280]) {
      await navigate("current", width);
      assert.ok(await evaluate(`(() => {
        const queue = document.querySelector(".admin-readiness-queue");
        const button = queue.querySelector(".button");
        const range = document.createRange(); range.selectNodeContents(button);
        const text = range.getBoundingClientRect(), box = button.getBoundingClientRect();
        return queue.scrollWidth <= queue.clientWidth && text.left >= box.left && text.right <= box.right;
      })()`), `${width}px long blocked-source alerts and Review text must fit their containers`);
    }
    await page("Browser.close").catch(() => {});
  } finally {
    socket?.close();
    if (child.exitCode === null) child.kill();
    await new Promise((done) => server.close(done));
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await rm(profile, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt === 19) throw error;
        await new Promise((done) => setTimeout(done, 200));
      }
    }
  }
});
