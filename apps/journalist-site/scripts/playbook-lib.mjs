/**
 * Reads the playbook's YAML files, checks them against the schema, and builds everything made
 * from them: `pipeline/playbook/compiled.json` (the bundle the app imports), the generated section
 * of skills/map-sources/SKILL.md, and playbook/rules-overview.html. Anything wrong throws.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PLAYBOOK_DIR = path.join(ROOT, "playbook");
export const SKILL_PATH = path.join(ROOT, "skills", "map-sources", "SKILL.md");
export const COMPILED_PATH = path.join(ROOT, "apps", "journalist-site", "pipeline", "playbook", "compiled.json");
export const OVERVIEW_PATH = path.join(PLAYBOOK_DIR, "rules-overview.html");

export const CATEGORY_FILES = ["events", "civic", "schools", "sports", "safety", "real_estate", "business", "obituaries", "community", "news", "weather"];
export const PARTS = ["goal", "prefer", "reject", "evidence", "search_playbook", "page_words", "when_to_stop", "examples"];
const PART_LABELS = { goal: "Goal", prefer: "Prefer", reject: "Reject", evidence: "Evidence", search_playbook: "Search playbook", page_words: "Page words", when_to_stop: "When to stop", examples: "Examples" };
export const CONSUMERS = { manual: "Manual scrapers", agent: "AI agent", google: "Google-operator services", non_google: "Non-Google services" };
export const BEGIN = "<!-- BEGIN GENERATED: category rules. Edit playbook/*.yaml, then run `npm run playbook` in apps/journalist-site. -->";
export const END = "<!-- END GENERATED: category rules -->";
/** The skill's tool steps, for a harness agent that has the newsbee-tools MCP server. The pipeline agent never gets them. */
export const HARNESS_BEGIN = "<!-- BEGIN HARNESS ONLY";
export const HARNESS_END = "<!-- END HARNESS ONLY -->";

/** What query patterns may ask for, beyond what a `for_each` list adds. */
const KIT_PLACEHOLDERS = ["place", "parent", "city", "state", "county", "city_domain", "zip"];
const FOR_EACH = { institutions: ["name"], venues: ["venue"], schools: ["school"], school_hosts: ["host"], agency_hosts: ["host"], funeral_hosts: ["host"], team_hosts: ["host"], association_school: ["association", "school"] };
const ORDERED_SETS = ["site_links", "school_site_links", "group_links", "osm_group_names", "item_keywords", "government_signals", "osm_kinds", "opendata_topics", "usual_addresses", "also_cover"];

const scalar = z.union([z.string(), z.number()]);
const rule = z.strictObject({
  id: z.string().regex(/^[a-z_]+\.[a-z0-9_]+\.[a-z0-9_]+$/), text: z.string().min(1).optional(), reason: z.string().min(1).optional(),
  consumers: z.array(z.enum(Object.keys(CONSUMERS))).min(1).optional(), from: z.string().optional(), set: z.string().optional(), order: z.number().int().min(0).optional(),
  stage: z.enum(["stage1", "stage2", "general", "lookup"]).optional(), source_type: z.string().optional(), pattern: z.string().min(1).optional(),
  regex: z.string().min(1).optional(), flags: z.enum(["i"]).optional(), value: scalar.optional(), values: z.array(z.string()).min(1).optional(), map: z.record(z.string(), z.unknown()).optional(),
  osm: z.strictObject({ kind: z.string(), tag: z.enum(["amenity", "tourism", "office", "shop", "leisure"]), priority: z.number().int(), story_kind: z.string().optional() }).optional(),
  opendata: z.strictObject({ topic: z.string(), query: z.string(), state_level: z.boolean() }).optional(),
  address: z.strictObject({ label: z.string() }).optional(), verdict: z.enum(["accepted", "rejected"]).optional(),
  for_each: z.strictObject({ list: z.enum(Object.keys(FOR_EACH)), limit: z.number().int().min(1), kinds: z.array(z.string()).min(1).optional() }).optional(),
});
const part = z.array(z.strictObject({ consumers: z.array(z.enum(Object.keys(CONSUMERS))).min(1), from: z.string().min(1), rules: z.array(rule).min(1) }));
const category = z.strictObject({ category: z.string(), label: z.string(), target: z.boolean(), topic: z.string().nullable(), ...Object.fromEntries(PARTS.map((name) => [name, part])) });
const operator = z.union([z.enum(["keep", "drop"]), z.strictObject({ parameter: z.string(), wildcards: z.literal("drop").optional() })]);
const service = z.strictObject({
  consumer: z.enum(["google", "non_google"]), label: z.string(), from: z.string(), note: z.string().optional(),
  operators: z.strictObject(Object.fromEntries(["site", "-site", "inurl", "intitle", "filetype", "after", "before"].map((name) => [name, operator]))),
  strip: z.strictObject({ match: z.enum(["after_space", "word_start"]), ignore_case: z.boolean() }).optional(), request: z.record(z.string(), z.unknown()).optional(),
}).refine((value) => value.consumer === "google" ? !value.strip : Boolean(value.strip && value.request), "a non-Google service needs `strip` and `request`; a Google one has no `strip`");
const services = z.strictObject({ services: z.record(z.string(), service) });

function parseFile(file, schema, dir) {
  const full = path.join(dir, `${file}.yaml`);
  if (!existsSync(full)) throw new Error(`Playbook file missing: playbook/${file}.yaml`);
  let parsed;
  try { parsed = parse(readFileSync(full, "utf8")); }
  catch (error) { throw new Error(`playbook/${file}.yaml is not valid YAML: ${error.message}`); }
  const checked = schema.safeParse(parsed);
  if (!checked.success) throw new Error(`playbook/${file}.yaml doesn't match the schema:\n${checked.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n")}`);
  return checked.data;
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);

function checkRule(rule, where) {
  const fail = (message) => { throw new Error(`${where} ${rule.id}: ${message}`); };
  if (!rule.text && !rule.pattern) fail("needs `text` or `pattern`");
  if (rule.regex !== undefined) { try { new RegExp(rule.regex, rule.flags); } catch (error) { fail(`the regex doesn't compile: ${error.message}`); } }
  if (rule.flags && !rule.regex) fail("`flags` needs a `regex`");
  if (ORDERED_SETS.includes(rule.set) && rule.order === undefined) fail(`rules in the set ${rule.set} need an \`order\``);
  if (rule.part === "examples" && !rule.verdict) fail("an example needs a `verdict`");
  if (["stage1", "stage2", "general"].includes(rule.stage)) {
    if (!rule.pattern) fail("a query needs a `pattern`");
    const allowed = [...KIT_PLACEHOLDERS, ...(rule.for_each ? FOR_EACH[rule.for_each.list] : []), ...(rule.stage === "stage2" ? ["after"] : [])];
    for (const name of placeholders(rule.pattern)) if (!allowed.includes(name)) fail(`the placeholder {${name}} isn't available here`);
  }
}

function checkSets(rules) {
  const sets = new Map();
  for (const rule of rules) if (ORDERED_SETS.includes(rule.set)) sets.set(rule.set, [...(sets.get(rule.set) ?? []), rule]);
  sets.set("general_queries", rules.filter((rule) => rule.stage === "general"));
  for (const name of ORDERED_SETS) if (!sets.has(name)) throw new Error(`No rules in the set ${name}`);
  for (const [name, list] of sets) {
    const orders = list.map((rule) => rule.order).sort((a, b) => a - b);
    if (orders.some((order, index) => order !== index)) throw new Error(`The set ${name} needs orders 0 to ${list.length - 1} with no gaps or repeats; it has ${orders.join(", ")}`);
  }
}

/** Every rule, with its group's consumers and origin filled in, and where it sits. */
export function loadPlaybook(dir = PLAYBOOK_DIR) {
  const expected = [...CATEGORY_FILES, "general", "services"];
  for (const name of readdirSync(dir)) if (name.endsWith(".yaml") && !expected.includes(name.slice(0, -5))) throw new Error(`Unexpected playbook file: playbook/${name}`);
  const documents = [...CATEGORY_FILES, "general"].map((file) => {
    const document = parseFile(file, category, dir);
    if (document.category !== file) throw new Error(`playbook/${file}.yaml says it is the category ${document.category}`);
    return document;
  });
  const serviceFile = parseFile("services", services, dir);
  const rules = [];
  const seen = new Set();
  for (const document of documents) for (const name of PARTS) for (const group of document[name]) for (const item of group.rules) {
    if (seen.has(item.id)) throw new Error(`Rule id used twice: ${item.id}`);
    seen.add(item.id);
    if (!item.id.startsWith(`${document.category}.`)) throw new Error(`${item.id} is in playbook/${document.category}.yaml: its id must start with ${document.category}.`);
    const full = { ...item, consumers: item.consumers ?? group.consumers, from: item.from ?? group.from, category: document.category, part: name };
    if (!existsSync(path.join(ROOT, full.from))) throw new Error(`${item.id} says it came from ${full.from}, which doesn't exist`);
    checkRule(full, `playbook/${document.category}.yaml`);
    rules.push(full);
  }
  checkSets(rules);
  const categories = documents.map(({ category: id, label, target, topic }) => ({ id, label, target, topic }));
  return { categories, rules, services: serviceFile.services };
}

const reachesAgent = (rule) => rule.consumers.includes("agent") && rule.map === undefined && !(rule.pattern && !rule.stage) && !rule.osm;
const line = (rule) => {
  const said = rule.text ?? rule.pattern;
  if (rule.values) return `${said} ${rule.values.join(", ")}`;
  return rule.value === undefined ? said : `${said} ${rule.value}`;
};

/** The category rules as the AI reads them. */
export function skillSection(playbook) {
  const out = ["## Rules by category", "", "These come from the shared playbook. A query pattern's `{placeholders}` stand for this place's details: fill them in, and leave out a pattern with no value for one."];
  const list = (title, rows) => { if (rows.length) out.push("", `${title}:`, ...rows.map((row) => `- ${row}`)); };
  for (const entry of [...playbook.categories.filter((item) => item.id !== "general"), ...playbook.categories.filter((item) => item.id === "general")]) {
    const rules = playbook.rules.filter((rule) => rule.category === entry.id && reachesAgent(rule));
    if (!rules.length) continue;
    const of = (name) => rules.filter((rule) => rule.part === name);
    out.push("", `### ${entry.label}`);
    list("Goal", of("goal").map(line));
    list("Prefer", of("prefer").map(line));
    list("Reject", of("reject").map(line));
    list("Evidence", of("evidence").map(line));
    list("Query patterns for lasting sources", of("search_playbook").filter((rule) => rule.stage === "stage1" || rule.stage === "general").map((rule) => `\`${rule.pattern}\``));
    list("Query patterns for new pages", of("search_playbook").filter((rule) => rule.stage === "stage2").map((rule) => `\`${rule.pattern}\``));
    list("When to stop", of("when_to_stop").map(line));
    list("Accepted", of("examples").filter((rule) => rule.verdict === "accepted").map((rule) => rule.text));
    list("Rejected", of("examples").filter((rule) => rule.verdict === "rejected").map((rule) => rule.text));
  }
  return out.join("\n");
}

/** SKILL.md with its generated section brought up to date. */
export function withSkillSection(text, section) {
  text = text.replace(/\r\n/g, "\n");
  section = section.replace(/\r\n/g, "\n");
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if (start < 0 || end < start) throw new Error("skills/map-sources/SKILL.md has lost its generated section markers");
  return `${text.slice(0, start + BEGIN.length)}\n\n${section}\n\n${text.slice(end)}`;
}

const skillBody = (text) => text.replace(/\r\n/g, "\n").replace(/^---[\s\S]*?---\s*/, "").trim();

/** The skill as the pipeline agent reads it: everything but the harness's tool steps. */
export function pipelineSkill(body) {
  const start = body.indexOf(HARNESS_BEGIN), end = body.indexOf(HARNESS_END);
  if (start < 0 && end < 0) return body;
  if (start < 0 || end < start) throw new Error("skills/map-sources/SKILL.md has a broken harness-only section");
  return `${body.slice(0, start).trimEnd()}\n\n${body.slice(end + HARNESS_END.length).trimStart()}`.trim();
}

/** Compiled rules. The version changes with any rule or the skill's text, including its harness part, and not with a comment. */
export function compile(playbook, skill) {
  const body = skillBody(skill);
  const version = createHash("sha256").update(JSON.stringify({ categories: playbook.categories, rules: playbook.rules, services: playbook.services, skill: body })).digest("hex").slice(0, 16);
  return { version, categories: playbook.categories, rules: playbook.rules, services: playbook.services, skill: pipelineSkill(body) };
}

// --- The readable copy ---------------------------------------------------------------------------

/** Rules kept in code on purpose: nothing here can be changed by editing the playbook. Each names its check group. */
export const LOCKED = [
  ["Private address checks", "No fetch may reach a private network address, on any hop.", "pipeline/connectors/public-http.ts", "Safety"],
  ["Crawl delays", "A site's crawl delay is always followed, and our fetcher reads one page at a time per site.", "pipeline/connectors/fetcher.ts", "Safety"],
  ["Robots checks", "A site's robots.txt is obeyed, and a site that turns away AI crawlers is skipped.", "pipeline/connectors/fetcher.ts", "Access"],
  ["Rights handling", "A page that opts out of reuse (noai) is skipped, or kept only as a link (nosnippet).", "pipeline/connectors/web/page.ts", "Access"],
  ["Site terms check", "A site's terms page is checked for limits on scraping.", "pipeline/discovery/evaluate.ts", "Access"],
  ["DO_NOT_SCRAPE", "The never-read list: Facebook, Nextdoor, Instagram, X, Twitter, Reddit, TikTok and Legacy.com aren't fetched.", "pipeline/connectors/fetcher.ts", "Access"],
  ["The locality check", "A source or item must show a real tie to the place, and a query must name the place, its city or a local institution, or stay inside a confirmed site.", "pipeline/connectors/locality.ts, pipeline/discovery/checks.ts, pipeline/discovery/topics.ts", "Quality and Evidence"],
  ["AI never sets inside_area", "Only the page's own title naming the place sets it, because that field skips the locality filter.", "pipeline/discovery/evaluate.ts", "Evidence"],
  ["Sensitive agent queries", "The agent's queries for login pages, admin pages, passwords and exposed data files are thrown away.", "pipeline/agent/map-sources.ts", "Safety"],
];

/** The four groups the page checks fall into, and whether each can be switched off. */
export const CHECK_GROUPS = [
  ["Safety", "Never open private addresses, and always follow crawl delays.", "No, always on."],
  ["Quality", "Reject known repost and aggregator sites, and pages clearly about another place.", "No, always on in Pipeline 1 discovery, whatever the run's guardrails."],
  ["Access", "Robots, AI opt-outs, noai and nosnippet tags, the terms check, and the never-read list.", "Yes, by the Access setting: Respect follows them, and Relaxed skips the ones ticked (none ticked means all). Relaxed is local only."],
  ["Evidence", "Locality and freshness facts: names, official site, addresses, and the dates found with where each came from.", "Not a pass-or-fail rule. Code decides only clear cases and marks the rest unclear, for the Gemini check."],
];

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const code = (text) => `<code>${escape(text)}</code>`;

/** A regex's alternatives, tidied for reading. The rule itself stays the exact regex. */
function words(regex) {
  const inner = /^\\b\((?!\?)(.*)\)\\b$/.exec(regex)?.[1] ?? regex;
  const parts = [];
  let depth = 0, current = "";
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === "\\") { current += char + inner[index + 1]; index += 1; continue; }
    if ("([".includes(char)) depth += 1;
    if (")]".includes(char)) depth -= 1;
    if (char === "|" && depth === 0) { parts.push(current); current = ""; } else current += char;
  }
  parts.push(current);
  return parts.map((text) => text.replace(/\\b/g, "").replace(/\(\?:/g, "(").replace(/\\\./g, ".").replace(/\$$/, "").replace(/^\^/, ""));
}

function ruleCard(rule) {
  const title = rule.text ?? rule.id.split(".").pop().replace(/_/g, " ");
  const rows = [];
  if (rule.source_type) rows.push(`<p class="tag">${escape(rule.source_type)}${rule.stage === "stage2" ? ", new pages" : rule.stage === "general" ? ", general budget" : ""}</p>`);
  if (rule.verdict) rows.push(`<p class="tag ${rule.verdict}">${rule.verdict === "accepted" ? "Accepted" : "Rejected"}</p>`);
  if (rule.pattern) rows.push(`<pre>${escape(rule.pattern)}</pre>`);
  if (rule.for_each) rows.push(`<p class="note">Repeated for up to ${rule.for_each.limit} of: ${escape(rule.for_each.list.replace(/_/g, " "))}${rule.for_each.kinds ? ` (${escape(rule.for_each.kinds.join(", ").replace(/_/g, " "))}, with no website on record)` : ""}</p>`);
  if (rule.regex) rows.push(`<p class="chips">${words(rule.regex).map(code).join(" ")}</p>`);
  if (rule.opendata) rows.push(`<p class="note">Search words: ${code(rule.opendata.query)}${rule.opendata.state_level ? ", also on state portals" : ""}</p>`);
  if (rule.values) rows.push(`<p class="chips">${rule.values.map(code).join(" ")}</p>`);
  if (rule.value !== undefined) rows.push(`<p class="value">${escape(rule.value)}</p>`);
  if (rule.osm) rows.push(`<p class="note">OpenStreetMap ${code(`${rule.osm.tag}=${rule.osm.kind}`)}, priority ${rule.osm.priority}</p>`);
  if (rule.map) rows.push(`<p class="chips">${Object.entries(rule.map).map(([key, value]) => code(`${key}: ${typeof value === "object" ? Object.values(value).join(", ") : value}`)).join(" ")}</p>`);
  if (rule.set === "hard_limits") rows.push('<p class="tag locked">Hard limit, enforced in code</p>');
  const reason = rule.reason ? `<p class="reason"><b>Why:</b> ${escape(rule.reason)}</p>` : "";
  const meta = `<p class="meta"><span>${rule.consumers.map((id) => escape(CONSUMERS[id])).join(" · ")}</span><span>${escape(rule.from.replace("apps/journalist-site/", ""))}</span><span>${code(rule.id)}</span></p>`;
  return `<article class="rule"><h4>${escape(title)}</h4>${rows.join("")}${reason}${meta}</article>`;
}

/** Facts about what a target category lacks. Nothing here suggests a rule. */
export function gaps(playbook) {
  return playbook.categories.filter((entry) => entry.target).map((entry) => {
    const rules = playbook.rules.filter((rule) => rule.category === entry.id);
    const of = (name) => rules.filter((rule) => rule.part === name);
    const notes = PARTS.filter((name) => !of(name).length).map((name) => `No ${PART_LABELS[name].toLowerCase()} rules`);
    if (of("examples").length) {
      if (!of("examples").some((rule) => rule.verdict === "accepted")) notes.push("No accepted examples");
      if (!of("examples").some((rule) => rule.verdict === "rejected")) notes.push("No rejected examples");
    }
    const withReason = rules.filter((rule) => rule.reason).length;
    notes.push(`${withReason} of ${rules.length} rules state a reason`);
    if (of("reject").length && of("reject").every((rule) => rule.set === "search_exclusions")) notes.push("Its only reject rule is a list of sites left out of searches");
    if (!of("goal").length || of("goal").every((rule) => rule.set === "also_cover")) notes.push("Its goal is only a line in the agent's \"also worth covering\" list");
    if (!rules.some((rule) => rule.set === "pages_per_site")) notes.push("No pages are kept for it when a site is scanned, so its link words have no effect there");
    return { id: entry.id, label: entry.label, notes };
  });
}

export function overview(compiled) {
  const { rules, categories, services: serviceList, version } = compiled;
  const count = (id, consumer) => rules.filter((rule) => rule.category === id && (!consumer || rule.consumers.includes(consumer))).length;
  const consumers = Object.keys(CONSUMERS);
  const summary = categories.map((entry) => `<tr><th scope="row"><a href="#${entry.id}">${escape(entry.label)}</a>${entry.id === "weather" ? ' <span class="tag">Not a target</span>' : ""}</th><td>${count(entry.id)}</td>${consumers.map((id) => `<td>${count(entry.id, id)}</td>`).join("")}</tr>`).join("");
  const totals = `<tr><th scope="row">Total</th><td>${rules.length}</td>${consumers.map((id) => `<td>${rules.filter((rule) => rule.consumers.includes(id)).length}</td>`).join("")}</tr>`;
  const sections = categories.map((entry) => {
    const parts = PARTS.map((name) => {
      const list = rules.filter((rule) => rule.category === entry.id && rule.part === name);
      return `<details${list.length && ["goal", "prefer", "reject", "examples"].includes(name) ? " open" : ""}><summary>${PART_LABELS[name]} <span class="count">${list.length}</span></summary>${list.length ? list.map(ruleCard).join("") : '<p class="empty">No rules here yet.</p>'}</details>`;
    }).join("");
    const lead = entry.id === "weather" ? '<p class="note">Not a target category. Its rules stay exactly as they are, and it is left out of the gaps below.</p>'
      : entry.id === "sports" ? '<p class="note">A target category of its own. School sports belong here, not under schools.</p>' : "";
    return `<section id="${entry.id}"><h3>${escape(entry.label)}</h3>${lead}${parts}</section>`;
  }).join("");
  const gapList = gaps(compiled).map((entry) => `<article class="rule"><h4>${escape(entry.label)}</h4><ul>${entry.notes.map((note) => `<li>${escape(note)}</li>`).join("")}</ul></article>`).join("");
  const locked = LOCKED.map(([name, what, where, group]) => `<article class="rule"><h4>${escape(name)} <span class="tag locked">Locked</span></h4><p>${escape(what)}</p><p class="meta"><span>${escape(group)}</span><span>${escape(where)}</span></p></article>`).join("");
  const groups = CHECK_GROUPS.map(([name, what, off]) => `<article class="rule"><h4>${escape(name)}</h4><p>${escape(what)}</p><p class="note"><b>Can it be switched off?</b> ${escape(off)}</p></article>`).join("");
  const operators = ["site", "-site", "inurl", "intitle", "filetype", "after", "before"];
  const describe = (value) => value === "keep" ? "Sent as written" : value === "drop" ? "Dropped" : `Becomes ${value.parameter}${value.wildcards ? ", wildcards dropped" : ""}`;
  const serviceRows = Object.values(serviceList).map((item) => `<article class="rule"><h4>${escape(item.label)}</h4><p class="tag">${escape(CONSUMERS[item.consumer])}</p>${item.note ? `<p>${escape(item.note)}</p>` : ""}<ul>${operators.map((name) => `<li>${code(`${name}:`)} ${escape(describe(item.operators[name]))}</li>`).join("")}</ul></article>`).join("");
  const targets = categories.filter((entry) => entry.target).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scraping Rules Overview</title>
<style>
:root { color-scheme: light dark; --bg: #faf9f6; --panel: #ffffff; --text: #1f2328; --muted: #5c6470; --line: #dfe1e5; --accent: #8a5a00; --code: #f1efe9; --good: #1a7f4b; --bad: #b3322a; }
@media (prefers-color-scheme: dark) { :root { --bg: #16181c; --panel: #1f2228; --text: #e8e9ec; --muted: #a2a9b4; --line: #343841; --accent: #e3b34e; --code: #2a2e36; --good: #5fce95; --bad: #f08a80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 8px; } h2 { margin: 40px 0 8px; font-size: 1.4rem; } h3 { margin: 32px 0 8px; font-size: 1.15rem; } h4 { margin: 0 0 6px; font-size: 1rem; font-weight: 600; }
a { color: var(--accent); } p { margin: 6px 0; } .lede, .meta, .note, .empty { color: var(--muted); } .meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: .8rem; margin-top: 8px; }
.table { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: .92rem; } th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: right; } th:first-child { text-align: left; font-weight: 500; } thead th { font-weight: 600; vertical-align: bottom; }
details { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; padding: 0 12px; } summary { cursor: pointer; padding: 10px 0; font-weight: 600; } .count { color: var(--muted); font-weight: 400; }
.rule { background: var(--panel); border-top: 1px solid var(--line); padding: 12px 0; } section > .rule, #gaps .rule, #locked .rule, #services .rule, #checks ~ .rule { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 8px 0; }
code, pre { font: .86em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); border-radius: 4px; } code { padding: 1px 5px; overflow-wrap: anywhere; } pre { padding: 8px 10px; margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.chips { line-height: 2; } .value { font-size: 1.2rem; font-weight: 600; } .tag { display: inline-block; font-size: .78rem; color: var(--accent); margin: 0 0 4px; } .accepted { color: var(--good); } .rejected, .locked { color: var(--bad); } ul { margin: 6px 0; padding-left: 20px; }
</style>
</head>
<body>
<main>
<h1>Scraping rules overview</h1>
<p class="lede">Every rule Newsbee's scrapers use to find sources, generated from the playbook. Rules version ${code(version)}. There are ${targets} target categories; weather is kept but isn't one.</p>
<h2 id="summary">Summary</h2>
<p class="note">A rule can have more than one user, so the columns don't add up to the total.</p>
<div class="table"><table><thead><tr><th scope="col">Category</th><th scope="col">Rules</th>${consumers.map((id) => `<th scope="col">${escape(CONSUMERS[id])}</th>`).join("")}</tr></thead><tbody>${summary}${totals}</tbody></table></div>
<h2 id="categories">Rules by category</h2>
${sections}
<h2 id="services">Search services</h2>
<p class="note">Query patterns are written once. These are the ways each service runs them.</p>
${serviceRows}
<h2 id="gaps">Weak or missing rules</h2>
<p class="note">Facts only, for the ${targets} target categories. Weather is left out.</p>
${gapList}
<h2 id="checks">Page checks</h2>
<p class="note">Every page discovery finds goes through these four groups of checks.</p>
${groups}
<h2 id="locked">Locked rules</h2>
<p class="note">Safety and legal rules stay in code, and editing the playbook can't change them.</p>
${locked}
<h2 id="edit">How to edit a rule</h2>
<ol>
<li>Find the rule above and note its id, such as ${code("safety.stage1.sheriff")}.</li>
<li>Open that category's file in the ${code("playbook")} folder, such as ${code("playbook/safety.yaml")}, and find the id.</li>
<li>Change the words. Keep the id the same, because results are tied to it. Keep text inside its single quotes, and write a single quote as two.</li>
<li>In ${code("apps/journalist-site")}, run ${code("npm run playbook")}. It checks your edit and refreshes this page, the AI's skill and the app's copy. A mistake stops it with a message naming the rule.</li>
<li>Run ${code("npm test")}. The snapshot tests will fail on purpose, showing what your edit changes. Have an engineer review that before updating them.</li>
</ol>
</main>
</body>
</html>
`;
}
