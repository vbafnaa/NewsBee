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

## The skill: a shared part and a harness part

`skills/map-sources/SKILL.md` has three parts. The shared part holds the role, the goal (the ten
categories), general principles only, where primary sources are found, and the boundaries. The part
between `<!-- BEGIN HARNESS ONLY` and `<!-- END HARNESS ONLY -->` holds the tool steps for a harness
agent that has the `newsbee-tools` MCP server (`place_profile`, `test_source`, `propose_source` and
the rest): the pipeline agent can't call those tools, so `npm run playbook` leaves that part out of
the compiled skill it is sent. The generated part holds the rules by category. Anything that applies
to one category, such as what to prefer, belongs in that category's file, not in the shared part.

## The pipeline agent's instructions and tools

At every step the pipeline agent is sent the compiled skill, then `general.search.agent_prompt`
(role, goal, the live category checklist, what it has tried). Into that prompt go three sets from
`general.yaml`, all plain text that anyone can edit:

| Set | What it holds |
| --- | --- |
| `agent_tools` | Short best practices for each tool: dorking, Exa, Tavily, site exploration, open, propose, not found |
| `research_habits` | Habits learned from people, worded for any city. The first is the directory habit |
| `habit_examples` | Worked examples of the habits, described by type of page, not by address |

When the agent stops, and when a category may be marked not found, are `general.stop.agent_*`
values (10 steps with nothing new; 8 searches across 2 tools). What code sends each search service
besides the query (results per search, US region and English) is each service's `request` in
`services.yaml`; a Tavily site exploration's depth is `general.search.tavily_explore_request`, and
the categories that search with a date range are `general.search.agent_date_range_days`. The
query patterns in each category's file are no longer run as a fixed batch: the skill shows them
to the agent as examples.

## Page checks and hard limits

Discovery's page checks fall into four groups: Safety, Quality, Access and Evidence (see
[rules-overview.html](rules-overview.html#checks) and `pipeline/discovery/checks.ts`). Safety and
Access are locked in code. Quality is named by `general.reject.quality_checks` and Evidence by
`general.evidence.evidence_facts`.

The hard limits for free-tier testing are the `hard_limits` set in `general.yaml`
(`general.stop.limit_<service>`), with `general.stop.run_minutes` for the whole run and
`general.stop.fetch_seconds_per_host` for our fetcher. Each limit's `map` can hold `per_second`,
`per_minute` (and `per_minute_without_key`), `per_hour`, `per_run`, `per_day` (from midnight
Pacific), `per_month`, `total`, a monthly spend guard `spend_per_month` with an `estimated_cost`
per call, and `pool`, another limit whose month or total it shares. The gateway enforces them.

## The model check

The instructions every route's sources are judged with, and the final review's, are
`general.search.gemini_check_prompt` and `general.search.final_review_prompt` in `general.yaml`. The
check asks "Does this keep publishing new, useful local information?", and is shown each category's
`prefer` and `reject` guidance and its `examples` (rules that hold a setting, such as a list or a
pattern, are for code and left out). `general.stop.gemini_check_batch` is how many sources one call
judges (a batch size, not a cap), `general.stop.gemini_check_page_chars` how much page text it reads,
`general.stop.gemini_check_titles` how many recent titles, `general.stop.gemini_check_decisions` how
many of the editor's past decisions it sees, and `general.stop.final_review_batch` how many sources the
final review compares in one call.

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

Safety and legal rules stay in code and can't be changed here: private address checks and crawl
delays (Safety); robots checks, rights handling, the terms check and `DO_NOT_SCRAPE` (Access, which a
relaxed local run may skip); the locality check; the rule that AI never sets `inside_area`; and the
refusal of agent queries for login pages and exposed data. Fetching and parsing
mechanics stay in code too.
