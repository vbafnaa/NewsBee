import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript, shared with the build script
import { BEGIN, CHECK_GROUPS, compile, COMPILED_PATH, END, gaps, HARNESS_BEGIN, HARNESS_END, loadPlaybook, LOCKED, overview, OVERVIEW_PATH, pipelineSkill, PLAYBOOK_DIR, ROOT, SKILL_PATH, skillSection, withSkillSection } from "../../../scripts/playbook-lib.mjs";
import { mappingSkill } from "../../agent/skill";
import { SEARCH_PROVIDERS } from "../../core/run-values";
import { newRun } from "../../orchestration/runs";
import { CATEGORIES_IN_PLAYBOOK, fill, limit, PLAYBOOK_RULES, PLAYBOOK_SERVICES, PLAYBOOK_SKILL, PLAYBOOK_VERSION, regex, rule } from "../../playbook";
import { tavilyRequest } from "../../search/provider";
import { CATEGORIES, SECTIONS } from "../../sourcemap/sections";
import { US_STATES } from "../../../../../shared/geography";

const read = (file: string | URL) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const app = (file: string) => read(path.join(ROOT, "apps/journalist-site", file));
const literals = JSON.parse(read(new URL("./main-literals.json", import.meta.url))) as { regexes: Array<{ file: string; source: string; flags: string }>; strings: string[] };
const mainSkill = read(new URL("./main-skill.md", import.meta.url));

describe("what is built from the playbook", () => {
  const playbook = loadPlaybook();
  const skill = withSkillSection(read(SKILL_PATH), skillSection(playbook));
  const compiled = compile(playbook, skill);

  it("is up to date: run `npm run playbook` if this fails", () => {
    expect(read(SKILL_PATH)).toBe(skill);
    expect(read(COMPILED_PATH)).toBe(`${JSON.stringify(compiled, null, 1)}\n`);
    expect(read(OVERVIEW_PATH)).toBe(overview(compiled));
  });

  it("notices a generated section edited by hand", () => {
    const edited = read(SKILL_PATH).replace("## Rules by category", "## Rules");
    expect(withSkillSection(edited, skillSection(playbook))).not.toBe(edited);
  });

  it("is checked before every production build", () => {
    expect(JSON.parse(app("package.json")).scripts.prebuild).toBe("node scripts/playbook.mjs --check");
  });

  it("changes version with a rule, not with a comment", () => {
    const changed = structuredClone(playbook);
    changed.rules[0].text = "Different";
    expect(compile(changed, skill).version).not.toBe(compiled.version);
    expect(compile(structuredClone(playbook), skill).version).toBe(compiled.version);
  });

  it("builds the same skill and version from Windows and Unix line endings", () => {
    const windows = skill.replace(/\n/g, "\r\n");
    expect(withSkillSection(windows, skillSection(playbook).replace(/\n/g, "\r\n"))).toBe(skill);
    expect(compile(playbook, windows)).toEqual(compiled);
  });
});

describe("a bad playbook fails loudly", () => {
  const broken = (change: (dir: string) => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), "playbook-"));
    cpSync(PLAYBOOK_DIR, dir, { recursive: true });
    try { change(dir); return () => loadPlaybook(dir); } finally { setTimeout(() => rmSync(dir, { recursive: true, force: true }), 2000); }
  };
  const swap = (file: string, from: string, to: string) => (dir: string) => {
    const full = path.join(dir, file);
    const text = read(full);
    expect(text).toContain(from);
    writeFileSync(full, text.replace(from, to));
  };

  it.each([
    ["a missing file", (dir: string) => rmSync(path.join(dir, "safety.yaml")), /missing: playbook\/safety.yaml/],
    ["a missing services file", (dir: string) => rmSync(path.join(dir, "services.yaml")), /missing: playbook\/services.yaml/],
    ["a stray file", (dir: string) => writeFileSync(path.join(dir, "extra.yaml"), "a: 1"), /Unexpected playbook file/],
    ["broken YAML", swap("news.yaml", "category: news", "category: [news"), /not valid YAML/],
    ["an unknown field", swap("news.yaml", "topic: news", "topic: news\ncolour: red"), /doesn't match the schema/],
    ["a regex that doesn't compile", swap("civic.yaml", "regex: 'official website'", "regex: '(official website'"), /doesn't compile/],
    ["a repeated id", swap("news.yaml", "news.stage1.local_radio", "news.stage1.city_news"), /used twice/],
    ["an id in the wrong file", swap("news.yaml", "news.stage1.local_radio", "safety.stage1.local_radio"), /must start with news/],
    ["an unknown placeholder", swap("news.yaml", `'"{city}" "{state}" (radio`, `'"{town}" "{state}" (radio`), /placeholder \{town\}/],
    ["a gap in an ordered set", swap("news.yaml", "order: 10", "order: 12"), /site_links needs orders/],
    ["an unknown consumer", swap("news.yaml", "consumers: [manual]", "consumers: [robot]"), /doesn't match the schema/],
    ["a source that doesn't exist", swap("news.yaml", "pipeline/discovery/area.ts", "pipeline/discovery/nowhere.ts"), /doesn't exist/],
  ])("refuses %s", (_, change, message) => {
    expect(broken(change)).toThrow(message);
  });

  it("refuses a service with no adapter settings", () => {
    expect(broken(swap("services.yaml", "    strip: { match: word_start, ignore_case: false }\n", ""))).toThrow(/needs `strip`/);
  });

  it("throws on a rule the code asks for that isn't there, or the wrong type", () => {
    expect(() => rule("general.stop.nothing")).toThrow(/no rule/);
    expect(() => limit("general.page.hub")).toThrow(/no number/);
    expect(() => regex("general.stop.osm_cap")).toThrow(/no regex/);
    expect(() => fill("{missing}", {})).toThrow(/Nothing to fill/);
  });

  it("refuses a skill that has lost its markers", () => {
    expect(() => withSkillSection("no markers", "x")).toThrow(/markers/);
  });

  it("compiles each regex once", () => {
    expect(regex("general.page.hub")).toBe(regex("general.page.hub"));
  });
});

describe("the move left nothing behind", () => {
  const inPlaybook = new Set(PLAYBOOK_RULES.flatMap((item) => item.regex ? [`${item.regex}/${item.flags ?? ""}`] : []));
  const code = (file: string) => app(`pipeline/${file}`);

  it("has each regex from origin/main in the playbook or still in code, never both", () => {
    // Tavily's and Exa's operator handling is now built from services.yaml; the snapshots pin its output.
    const adapter = (file: string, source: string) => file === "search/provider.ts" && /site|after|^\\s\+$/.test(source);
    const missing = literals.regexes.filter(({ file, source, flags }) => !adapter(file, source) && !inPlaybook.has(`${source}/${flags}`) && !code(file).includes(`/${source}/${flags}`));
    expect(missing).toEqual([]);
    for (const { file, source, flags } of literals.regexes) {
      if (adapter(file, source)) continue;
      const moved = inPlaybook.has(`${source}/${flags}`);
      const kept = code(file).includes(`/${source}/${flags}`);
      if (moved) expect(kept, `copy left in ${file}: /${source}/${flags}`).toBe(false);
    }
  });

  it("has every query template from origin/main in the playbook, and none in code", () => {
    const patterns = new Set(PLAYBOOK_RULES.map((item) => item.pattern));
    const queries = literals.strings.filter((text) => /[ "]/.test(text));
    expect(queries.length).toBeGreaterThan(70);
    for (const text of queries) {
      expect(patterns.has(text), text).toBe(true);
      expect(code("discovery/topics.ts"), text).not.toContain(text);
    }
  });

  it("has a shared skill with the goal and general principles only, and the old text's tool steps for the harness", () => {
    const now = read(SKILL_PATH);
    const shared = pipelineSkill(now.replace(/^---[\s\S]*?---\s*/, "").trim());
    const handWritten = shared.slice(0, shared.indexOf(BEGIN));
    for (const category of ["Events", "Council and government", "Schools", "Crime, police and safety", "Real estate and home sales", "Business", "Community", "Other news", "Obituaries", "Sports"]) expect(handWritten, category).toContain(category);
    expect(handWritten).toMatch(/Weather is not a category/);
    for (const principle of ["First-party beats rewrites", "keep publishing beat one-off pages", "A feed, calendar or dataset beats scraping a page"]) expect(handWritten).toContain(principle);
    // Category preferences live in the category files, not in the shared part.
    for (const preference of ["police and sheriff logs", "funeral homes,", "assessor and recorder", "athletics pages", "Original civic records", "first-party business updates"]) expect(handWritten.toLowerCase(), preference).not.toContain(preference.toLowerCase());
    expect(shared).toContain("Police and sheriff logs, and court notices.");
    expect(shared).toContain("County assessor and recorder records");
    // The old skill's tool steps survive, for the harness only.
    const harness = now.slice(now.indexOf(HARNESS_BEGIN), now.indexOf(HARNESS_END));
    for (const line of ["Call `place_profile` and `coverage`.", "`propose_source` for what passes, with why it is useful.", "## Learning from decisions"]) expect(harness).toContain(line.replace("topic", "category"));
    expect(mainSkill).toContain("## How to work");
  });

  it("sends the pipeline agent no instructions for tools it can't call", () => {
    for (const tool of ["place_profile", "test_source", "propose_source", "list_site_links", "find_endpoints", "`coverage`", "newsbee-tools", "searchapi"]) expect(PLAYBOOK_SKILL, tool).not.toContain(tool);
    expect(read(SKILL_PATH)).toContain("list_site_links");
  });

  it("lists no query pattern twice for the agent", () => {
    const patterns = PLAYBOOK_SKILL.split("\n").filter((line) => /^- `.*`$/.test(line));
    const repeated = patterns.filter((line, index) => patterns.indexOf(line) !== index && !/\{(name|venue|school|host|association)\}/.test(line));
    expect(repeated).toEqual([]);
  });

  it("gives the AI the category rules, from the same file as the harness", () => {
    expect(mappingSkill().text).toBe(PLAYBOOK_SKILL);
    expect(read(SKILL_PATH)).toContain(BEGIN);
    expect(read(SKILL_PATH)).toContain(END);
    expect(pipelineSkill(read(SKILL_PATH).replace(/^---[\s\S]*?---\s*/, "").trim())).toBe(PLAYBOOK_SKILL);
    for (const item of PLAYBOOK_RULES) if (item.part === "examples" || item.stage === "stage1" || item.stage === "stage2") expect(PLAYBOOK_SKILL, item.id).toContain(item.text ?? item.pattern);
  });

  it("can't lose the skill from a bundle, or fall back silently", () => {
    expect(app("pipeline/agent/skill.ts")).not.toMatch(/readFileSync|FALLBACK/);
    expect(app("next.config.ts")).not.toContain("SKILL.md");
    expect(app("pipeline/playbook/index.ts")).toContain('from "./compiled.json"');
  });
});

describe("categories", () => {
  it("has one file per section, with the section's label", () => {
    const labels = Object.fromEntries(CATEGORIES_IN_PLAYBOOK.map((item) => [item.id, item.label]));
    for (const section of SECTIONS) expect(labels[section.id]).toBe(section.label);
  });

  it("has ten target categories, without weather", () => {
    const targets = CATEGORIES_IN_PLAYBOOK.filter((item) => item.target).map((item) => item.id);
    expect(targets.sort()).toEqual([...CATEGORIES].sort());
    expect(targets).not.toContain("weather");
  });

  it("leaves weather out of the gaps, and marks it not a target", () => {
    const playbook = loadPlaybook();
    expect(gaps(playbook).map((item: { id: string }) => item.id)).not.toContain("weather");
    expect(gaps(playbook)).toHaveLength(10);
    expect(read(OVERVIEW_PATH)).toContain("Not a target");
  });

  it("gives every rule an id, an origin and a consumer", () => {
    for (const item of PLAYBOOK_RULES) {
      expect(item.consumers.length, item.id).toBeGreaterThan(0);
      expect(item.from, item.id).toBeTruthy();
    }
  });

  it("names no real place", () => {
    const states = Object.values(US_STATES) as string[];
    const text = PLAYBOOK_RULES.flatMap((item) => [item.pattern, item.text, item.reason, item.regex, ...(item.values ?? [])]).filter(Boolean).join("\n");
    for (const state of states) expect(new RegExp(`\\b${state}\\b`).test(text), state).toBe(false);
    expect(read(path.join(PLAYBOOK_DIR, "services.yaml"))).not.toMatch(/\.k12\.[a-wyz][a-z]\.us/);
  });
});

describe("services", () => {
  it("covers every search provider", () => {
    expect(Object.keys(PLAYBOOK_SERVICES).sort()).toEqual(SEARCH_PROVIDERS.filter((provider) => provider !== "fixture").sort());
  });

  it("drops Tavily's wildcard filters, as it always has", () => {
    expect(tavilyRequest('site:.k12.xx.us site:a.example.org -site:.gov "Lakeside"')).toEqual({ query: '"Lakeside"', max_results: 10, search_depth: "basic", topic: "general", country: "united states", include_domains: ["a.example.org"] });
  });
});

describe("locked rules", () => {
  it("stay in code, and out of the playbook", () => {
    expect(app("pipeline/connectors/fetcher.ts")).toContain("export const DO_NOT_SCRAPE");
    expect(app("pipeline/connectors/fetcher.ts")).toContain("robotsReason");
    expect(app("pipeline/discovery/evaluate.ts")).toContain("rightsAction(pageRights(");
    expect(app("pipeline/discovery/evaluate.ts")).toContain("inside_area: Boolean(named && mentions(pageTitle, named))");
    expect(app("pipeline/discovery/topics.ts")).toContain("export function isLocalQuery");
    expect(app("pipeline/connectors/public-http.ts")).toContain("publicSourceTransport");
    const editable = JSON.stringify(PLAYBOOK_RULES.map(({ reason: _reason, text: _text, from: _from, ...item }) => item));
    expect(editable).not.toMatch(/robots|DO_NOT_SCRAPE|inside_area/i);
  });

  it("are listed separately on the readable copy, each in its check group", () => {
    const html = read(OVERVIEW_PATH);
    for (const [name, , , group] of LOCKED as string[][]) { expect(html).toContain(name.replace(/&/g, "&amp;")); expect(["Safety", "Access", "Evidence", "Quality and Evidence"]).toContain(group); }
    for (const [name] of CHECK_GROUPS as string[][]) expect(html).toContain(`<h4>${name}</h4>`);
  });
});

describe("the readable copy", () => {
  const html = read(OVERVIEW_PATH);

  it("stands alone, in light and dark", () => {
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//);
  });

  it("shows every rule, the summary and how to edit", () => {
    for (const item of PLAYBOOK_RULES) expect(html, item.id).toContain(item.id);
    for (const heading of ["Summary", "Weak or missing rules", "Locked rules", "How to edit a rule"]) expect(html).toContain(heading);
  });
});

it("records the playbook version on each run", () => {
  const run = newRun({ id: "loc", name: "Lakeside" }, { kind: "manual", by: "test" } as never, "2026-11-06", ["2026-11-01", "2026-11-06"], []);
  expect(run.playbook_version).toBe(PLAYBOOK_VERSION);
  expect(PLAYBOOK_VERSION).toMatch(/^[0-9a-f]{16}$/);
});
