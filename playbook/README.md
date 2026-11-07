# Scraping rules playbook

One set of editable rules that every Newsbee scraper reads, so what we learn about finding sources
belongs to us and isn't tied to one service. [rules-overview.html](rules-overview.html) is the
readable copy, generated from these files.

| Who reads the rules | How |
| --- | --- |
| Manual scrapers (`manual`) | The fixed discovery methods read them as settings |
| AI agent (`agent`) | The mapping agent reads them as text, in the generated section of `skills/map-sources/SKILL.md`. The `opencode.json` harness reads the same file |
| Google-operator services (`google`) | SerpApi, SearchApi and Bright Data run query patterns as written |
| Non-Google services (`non_google`) | Tavily and Exa run the same patterns through an adapter, following `services.yaml` |

## Files

One file per category, `general.yaml` for rules that apply everywhere, and `services.yaml` for what
each search service understands. There are ten target categories: events, civic, schools, sports,
safety, real_estate, business, obituaries, community and news. School sports belong under sports.
`weather.yaml` keeps its rules but isn't a target (`target: false`), so it is left out of gap and
coverage assessments.

Each category has the same parts, and a part can be empty:

| Part | What it holds |
| --- | --- |
| `goal` | What this category is looking for |
| `prefer` | Source types we want |
| `reject` | What we exclude, and why |
| `evidence` | What we record for a source |
| `search_playbook` | Query patterns, with placeholders such as `{place}` and `{city_domain}`, never real place names |
| `page_words` | What fixed code matches on a page |
| `when_to_stop` | Limits and budgets |
| `examples` | Accepted and rejected sources, with reasons |

Each part is a list of groups. A group's `consumers` and `from` (where the rule came from) apply to
every rule in it, and a rule can set its own. Each rule has a stable `id`: code and results refer to
it, so don't rename one.

## Editing a rule

1. Change the rule in its file. Keep regexes and query patterns in single quotes, and write a single
   quote as two.
2. In `apps/journalist-site`, run `npm run playbook`. It validates the files and rebuilds
   `pipeline/playbook/compiled.json`, the generated section of the skill, and the overview.
3. Run `npm test`. The snapshot tests in `pipeline/tests/playbook` were taken before the rules moved,
   so a changed rule fails them on purpose. Check that what changed is what you meant, then update
   them with `PLAYBOOK_WRITE_GOLDEN=1 npx vitest run pipeline/tests/playbook/snapshots.test.ts`.

Order matters in some sets, because the first match wins: `order` numbers there must run from 0 with
no gaps. The skill's hand-written text above its markers is edited in `SKILL.md`, and is part of the
rules' version.

## Why YAML, compiled at build time

**YAML, not JSON.** Nearly every rule is a quoted search phrase or a regex. In JSON each `"` and `\`
needs escaping, so `"{place}" "{state}"` becomes `\"{place}\" \"{state}\"` and `\b` becomes `\\b`,
which no one can review. YAML single quotes keep them exactly as they run, and allow comments.

**Compiled, not read at run time.** The app imports `compiled.json`, so the rules are in the deployed
Vercel bundle by construction. They can't go missing the way a file read from disk can, and there is
no fallback to silently change behaviour. YAML parsing and the schema are build-time only.

**Failing loudly.** `npm run build` first runs `scripts/playbook.mjs --check`, which stops the build if
a file is missing, doesn't match the schema, or anything made from it is out of date. A rule the code
asks for that isn't there throws when the module loads. Regexes are kept as strings and compiled once.

## Version

Each run stores `playbook_version` on its run record: a content hash of the rules and the skill's text,
so results can be tied to a set of rules. A comment doesn't change it. Generation and freshness checks
normalize Windows and Unix line endings, so the same rules have the same version on either platform.

## Locked

Safety and legal rules stay in code and can't be changed here: robots checks, rights handling, the
terms check, `DO_NOT_SCRAPE`, the locality check, private address checks, the rule that AI never sets
`inside_area`, and the refusal of agent queries for login pages and exposed data. Fetching and parsing
mechanics stay in code too.
