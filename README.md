# Newsbee

Newsbee turns a community into a weekly local newspaper edition. Onboard a location and the
pipeline finds that place's sources, reads everything they publish, keeps what is local,
sorts it into newsletter sections, and writes personable stories from the facts. A
journalist workspace runs and debugs the pipeline; a public reader site shows each
community's edition with a source-link dropdown. Editorial source maps stay internal.

```mermaid
flowchart LR
  Onboard[Onboard location] --> Discover[Discover sources] --> Map[(Source map)]
  Map --> Collect[Collect: websites, open data, news search, APIs]
  Collect --> Local[Keep what is local] --> Merge[Merge repeats, skip what was printed]
  Merge --> Sections[Sections] --> Rank[Rank 10 per section] --> Write[Details, floor, write]
  Write --> Publish[Publish up to 5 per section] --> Reader[Public reader newsletter]
  Publish --> Review[Password-protected edition decisions]
  Editors[Journalist console] --> Map
  Readers[Reader suggestions and stories] --> Inputs[Editor input review] --> Map
  Agent[Agentic flow: operator search and mapping agent] --> Map
  Agent --> Collect
```

One click runs the whole pipeline. You choose the options once, and the **source map** page
then shows every choice the run made, from its first search to the printed edition. Two flows
run side by side, and share everything from assembly onward:

| Step | `current` flow | `agentic` flow |
| --- | --- | --- |
| **Stage 1:** find and save sources | Eleven fixed discovery methods; new sources go live | Those, plus Google operator search (`dork`) and a mapping agent; new sources are `proposed` with evidence, and only agentic runs read them |
| **Stage 2:** read sources for the window | The readers | The readers, plus topic sweeps, tracing stories to original records, and agent extraction for pages the readers can't parse |
| Assemble, rank, write, publish | Shared | Shared; the primary source leads a merged story |

## Scraping rules

Every kind of scraper reads one set of editable rules in [playbook/](playbook/README.md): the fixed
discovery methods, the mapping agent, the Google-operator search services, and Tavily and Exa through
an adapter. [playbook/rules-overview.html](playbook/rules-overview.html) is the readable copy. Safety
and legal rules stay locked in code. Each run records the rules' version.

## Run locally

**1. Install** Node.js 24 with npm 11, and [Ollama](https://ollama.com/download) if you
want a local model. Check with `node -v` and `npm -v`.

**2. Choose a model.** Put settings in `apps/journalist-site/.env.local` (git-ignored; never
commit keys):

```ini
# Hosted model (recommended: faster and better writing). Ollama is the fallback.
NEWSBEE_MODEL_PROVIDERS=gemini,ollama
NEWSBEE_GEMINI_API_KEY=your-key-from-aistudio.google.com
NEWSBEE_GEMINI_MODEL=gemini-flash-latest

# Local model only: leave the lines above out, then run `ollama pull qwen3:4b`.
# Ollama must be running (the Ollama app, or `ollama serve`) at:
NEWSBEE_OLLAMA_URL=http://127.0.0.1:11434
NEWSBEE_OLLAMA_MODEL=qwen3:4b

# Optional
NEWSBEE_VOICE=lively                         # plain | lively | bold
NEWSBEE_RANKING=v5                           # v5 | classic
NEWSBEE_GEMINI_LIGHT_MODEL=gemini-flash-lite-latest   # detail extraction and source discovery
NEWSBEE_MODEL_DAILY_CALLS=800                # cap for extraction and discovery (stay under your free tier)
NEWSBEE_NEWS_SEARCH=gdelt                    # gdelt | llm | gdelt,llm | off
NEWSBEE_LLM_DISCOVERY=on                     # Gemini suggests sources at discovery; each is checked
NEWSBEE_INTERNAL_PASSWORD=<set-a-private-password> # shared gate for both internal maps
```

Other OpenAI-compatible APIs (OpenAI, Groq, Azure) are listed under
[Model providers](apps/journalist-site/README.md#model-providers).

**3. Start** from the repository root:

```text
npm --prefix apps/journalist-site ci
npm --prefix apps/reader-site ci
npm --prefix apps/journalist-site run local
```

This starts a local MongoDB, the console at http://127.0.0.1:3000 (no sign-in on
localhost), the reader at http://127.0.0.1:4321/reader and a scheduler tick every 5 s.
Data lives under the ignored `.local/stage2/` (MongoDB and a local stand-in for Drive).
The first run downloads MongoDB, and the first location search loads the Census and
library directories, so allow a minute or two. Stop with Ctrl+C.

**4. Make an edition.** In **Location workspaces**, search for a town or a neighbourhood (for example
`Ballard, Seattle`, then **Search all communities**), add it, open its workspace's
**Pipeline & logs**, choose the run options and click **Refresh source map**. When that finishes,
click **Create edition**. It reads the map, collects, writes and publishes with no further clicks. Open **Editions** to read
the result, or the password-protected **Source map → Run funnel** to see every choice it made.
The **Newsroom overview** shows every location's progress. Choose **Manual** run mode to stop
after collection and after writing, for debugging one stage.

Paid services are off until you tick them for a run, so with the defaults a run makes no paid
calls and uses Ollama. See [Run options](#run-options) and [APIs and paid calls](#apis-and-paid-calls).

**Troubleshooting:** "No model provider can serve requests" means the API key is missing or
wrong, or Ollama isn't running or the model isn't pulled (`ollama list`). Hosted models can
rate-limit; runs pause and resume automatically.

## Run options

Config sets the defaults; the kick-off panel overrides them for one run. The choices are saved
on the run, so a resumed run keeps them.

| Setting | Values (default first) | Controls |
| --- | --- | --- |
| `NEWSBEE_RUN_MODE` | `autopilot`, `manual` | Whether a run stops after collection and after writing |
| `NEWSBEE_PIPELINE_FLOW` | `current`, `agentic` | An edition's flow: agentic adds topic sweeps |
| `NEWSBEE_MAP_FLOW` | `current`, `agentic` | A source map run's method: agentic adds operator search and the mapping agent. Defaults to the flow above |
| `NEWSBEE_GUARDRAIL_PROFILE` | `strict`, `exploration` | Editorial and quality rules |
| `NEWSBEE_GUARDRAILS_OFF` | `caps` (default), `quality`, `sensitive`, `topic_content`, `none` | Turn off groups without full exploration. Unset means caps off, so nothing is capped; `none` turns every group back on. See [Limits](apps/journalist-site/README.md#limits) |
| `NEWSBEE_ACCESS_POLICY` | `respect`, `relaxed` | Site preference rules |
| `NEWSBEE_ACCESS_IGNORE` | `robots`, `ai_optout`, `noai`, `nosnippet`, `terms` | Which rules relaxed skips; empty means all of them |
| `NEWSBEE_COUNT_HISTORY` | `on`, `off` | Whether the run updates the no-repeat ledger and edition window; turn off for comparison runs |
| `NEWSBEE_PAID_ALLOW` | Service ids | Which paid services a run may call; empty means none |
| `NEWSBEE_PAID_BUDGETS` | For example `serpapi:200` | Maximum calls per run |
| `NEWSBEE_EXTERNAL_OFF` | Service ids | Free external APIs to switch off |
| `NEWSBEE_SEARCH_PROVIDER` | `serpapi`, `searchapi`, `brightdata`, `exa`, `tavily`, `fixture` | The search behind the agentic flow; `fixture` is a free, local-only test that answers from the location's own source map |
| `NEWSBEE_URL_CLASSIFIER` | `off`, `shadow`, `jev` | Whether Jev scores are ignored, recorded or used |
| `NEWSBEE_PRIORITY_TOPICS` | `crime`, `deaths`, `events`, `home_sales`, `sports`, `government`, `schools`, `business`, `community`, `news` | Topics that drive search and the coverage report; default all |
| Story limit (kick-off panel only) | A number | Write at most this many stories, for quick test runs on a local model |

**Exploration** flags items instead of dropping them, and each records what strict would have
stopped. Caps come off, locality and validator failures are kept and flagged, and home sales,
death notices and sports reprint what is available. A story that doesn't name the place or its
city is still dropped, so state, national and foreign news stays out. Names of minors in crime stories, names of
sexual or domestic violence victims, and suicide method are still removed.

**Relaxed** skips robots.txt, AI opt-outs, `noai` and `nosnippet` tags and the terms check.
Paywalled text, login walls, blocked social sites, crawl delays and the private-address check
stay on, and no anti-bot evasion is used. Ignoring site preferences can breach a site's terms, and
copyright can still apply.

Both **publish like any other run**, locally and when deployed, so on a deployed environment
their stories reach live readers. They count toward story history unless you untick it for a
comparison run. Stored text from relaxed runs can't feed other runs, and
`DELETE /api/admin/relaxed-content` removes that text and the collected items, but not editions
already published.

## APIs and paid calls

Every paid call goes through one gateway (`pipeline/trace/gateway.ts`), which checks the run's
allowance and budget, then logs the call. Unticked or over budget, the step is skipped and
logged, and the run continues. A service with no key stays off. Costs are estimates.

| Service | Key | Used for | Cost |
| --- | --- | --- | --- |
| SerpApi | `NEWSBEE_SERPAPI_API_KEY` | Google operator search | Paid |
| SearchApi | `NEWSBEE_SEARCHAPI_API_KEY` | Google operator search | Paid |
| Bright Data | `NEWSBEE_BRIGHTDATA_API_KEY`, `NEWSBEE_BRIGHTDATA_ZONE` | Google operator search | Paid |
| Exa | `NEWSBEE_EXA_API_KEY` | Coverage comparison | Paid |
| ScrapingBee | `NEWSBEE_SCRAPINGBEE_API_KEY` | JavaScript-rendered pages, anti-bot options off | Paid |
| Jev (TypeSafe) | `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`; `NEWSBEE_JEV_MODEL` | Classifying results, pages and items | Paid |
| Agent model | The model provider's key | Agent planning and extraction on a hosted model | Paid unless on Ollama |
| ATTOM | `NEWSBEE_ATTOM_API_KEY` | Home sale prices, if county records are thin | Paid |
| Gemini | `NEWSBEE_GEMINI_API_KEY` | Writing, ranking, extraction, discovery | Paid or free tier, by key |
| OpenAI-compatible APIs | `NEWSBEE_LLM_<NAME>_*` | Model fallback | Paid |
| Tavily | `NEWSBEE_TAVILY_API_KEY` | Council documents and agent search | Free tier, then paid |
| Ollama | None | Local model fallback | Free |
| GDELT, Overpass, Nominatim, Socrata, NWS, Wikidata, Bluesky, county records | None | Public data | No key; logged, with an on/off switch |

These integrations are connected but haven't been called with real keys yet, so expect to adjust
them once keys are set. In particular, Jev's direct endpoint and ATTOM's response fields come
from third-party references and summaries.

## Priority topics

Each location should pull ten topics. They drive query generation in both stages, each with a
guaranteed share of the query budget, and each run reports its coverage of them.

| Topic | Sources | Prints as |
| --- | --- | --- |
| Local crime | Police and fire data, sheriff and police blotters, prosecutors | Stories |
| Death notices | Funeral homes, family submissions | Compact list; strict prints name, dates and service details with a link |
| Local events | Venue, parks, library, school and neighbourhood calendars | Events |
| Home sales and permits | County sales files and datasets (`property` reader), city permits, ATTOM if ticked | Compact list; strict leaves out buyer and seller names |
| Local sports | School athletics, state associations, local teams and leagues | New Sports section; scores as a compact list |
| Council and government | Agendas and minutes, hearing notices, boards and commissions, meeting platforms | Stories |
| Schools, boards and PTAs | District sites, school board meetings and calendars, PTA, PTSA and PTO pages | Stories |
| Business openings, closings and offers | Chambers, downtown groups, city business pages, licences, news of openings and closings | Stories |
| Community groups and volunteering | Neighbourhood councils, nonprofits, service clubs, volunteer centres | Stories |
| Other local news | Local papers, neighbourhood blogs, city news pages | Stories |

Each county publishes sales differently, so home sales coverage varies most. Merchant discounts
have no public feed: the fixed methods can reach a chamber or downtown group's pages, but only
search can look for offers themselves.

A map run ends by counting sources for the ten editorial categories (events, council, schools,
sports, safety, real estate, business, community, other news, obituaries) and naming any that came
up empty. National readers are counted apart, so they can't hide a gap. See **Sources by category**
in the Run funnel. Weather stays a section outside that list.

## How sources are found and read

Each location has a **source map** (MongoDB `source_map`), built by discovery methods that
run when due (each has its own refresh period) and edited by editors. Collection reads only
from the map. Onboarded profiles and source inventory live in MongoDB; optional reviewed
community overrides and connector defaults are not an exhaustive location/source catalog.

| Discovery method | Finds |
| --- | --- |
| City and county websites | Official sites (checked city site, OpenStreetMap, Wikidata), their CivicPlus feeds, their category pages (agendas, hearings, boards, police and fire, permits, business, parks, volunteering), and the groups they link to |
| OpenStreetMap places | Websites of town halls, police and fire stations, courts, libraries, community centres, schools, venues, museums, markets, newspapers, nonprofits, associations and funeral homes inside the area |
| Meeting platforms | Legistar, CivicClerk and PrimeGov accounts for the city and county |
| Open-data portals | Socrata datasets for police and fire calls, permits, inspections, licences and 311 |
| Newsrooms and athletics | Wikidata outlets published nearby with a current feed; the state athletic association |
| School districts | The districts covering the place (Census, NCES directory), their board meetings, calendars and news, and local schools' PTA, PTSA or PTO pages |
| Local groups | Chambers, downtown and neighbourhood groups at their usual addresses, each fetched and checked, and funeral homes' obituary pages |
| News publishers | Outlets that news search keeps finding covering the place |
| LLM discovery | Gemini (Flash-Lite) suggestions: schools, PTAs, leagues, funeral homes, business groups; each fetched and checked |
| National | NWS, USGS, EPA, Census, Justice Department, Wikipedia, library systems, reader stories, family notices |
| Google operator search (agentic flow) | Narrow `site:`, `inurl:` and `filetype:` queries per priority topic. Each query names the place, its city or a local institution, or stays on a confirmed site, so nothing searches a whole county, state or region. Each result is fetched and checked before it becomes a source |
| Mapping agent (agentic flow) | Works outward from the city's checked website and local institutions, then each good site's other sections, then planned queries for the thinnest topics. Stops when leads run out and new primary sources dry up. Its instructions are in [skills/map-sources/SKILL.md](skills/map-sources/SKILL.md), whose category section is generated from the [playbook](playbook/README.md) |

Sources carry a `source_tier`: `official`, `organisation`, `business`, `local_reporting` or
`repost`. Primary sources lead merged stories, rank higher in each section, and lead the edition,
with local stories first and then priority topics. Original local journalism keeps its place, and
only rewrites are demoted. Each priority topic has its own allowance of city-wide stories.

Before an agentic source is saved, it is tested:

- **Exact page:** the page itself is the source, so a city's agenda centre and calendar stay separate. A single dated story becomes its listing page.
- **Coverage:** each source records its `scope`: `place`, `city` or `county`. A county source is kept if it is first-party, and each of its items still has to pass the locality filter.
- **Format:** it looks for a working feed or calendar, recognising platforms such as CivicPlus, Trumba, Google Calendar, WordPress and Squarespace, and parses each one before believing it. It records a `source_kind`: `feed`, `calendar`, `dataset`, `document_list`, `listing` or `lookup`.
- **Current:** a page with plenty of dates, all old, is rejected. Lookup forms, dashboards and pages with no dates stay as links for editors and aren't read.
- **The city's website:** the address on a location is checked as really being the city's before any `site:` query uses it, and corrected if not.

To run the agent from a harness instead, [opencode.json](opencode.json) connects
`apps/journalist-site/scripts/newsbee-tools-mcp.mjs`, an MCP server giving it `place_profile`,
`coverage`, `search`, `fetch_page`, `list_site_links`, `find_endpoints`, `test_source`,
`check_rights`, `classify` and `propose_source` through the running local stack. Set
`NEWSBEE_AGENT_LOCATION` to a location id. `propose_source` runs the checks above and saves what
passes as `proposed`.

To compare a source map with a list people researched by hand, run this. The list stays outside the
code, because discovery has to work for any location. Set `NEWSBEE_MONGODB_URI` to score a deployed
database:

```bash
cd apps/journalist-site
node scripts/score-sources.mjs <location id> <file of URLs, one per line>
```

[opencode.json](opencode.json) and [.mcp.json](.mcp.json) also connect SearchApi's own MCP server,
for its other engines such as Google Maps and Google Events. Set `MCP_TOKEN` to your SearchApi MCP
token. Its calls go straight to SearchApi, so they count against your SearchApi plan but skip the
run's budget and API log. Pipeline runs don't use it: they call SearchApi through the gateway with
`NEWSBEE_SEARCHAPI_API_KEY`.

| Reader | What it reads |
| --- | --- |
| `web` | Any website: feed, iCal, schema.org data, recent sitemap pages and story links (10 robots-checked requests per site); full text kept 30 days for details and locality |
| `opendata` | Any Socrata dataset on the map; police and fire calls become incidents with plain-word call types, block-level places and unit counts |
| `newssearch` | GDELT news search for the place (Gemini grounded search optional) |
| `sweep` | Agentic runs only: `after:` operator queries per priority topic, and tracing secondary stories to original records. Each result is fetched and checked |
| `property` | Recorded home sales with prices: county data files, open-data sales datasets and, when ticked, ATTOM |
| `library`, `meetings`, `hazards`, `trending`, `homesafety`, `housing`, `justice`, `community`, `remembrance` | The existing API readers |

Each reader type has a **lookup window**: news-like sources read since the last edition
(capped per type), events read ahead. Stories printed before are skipped unless they bring
new facts (printed as an update); events print at most twice. Items must show they concern
the community (coordinates, a source inside the area, naming it or a landmark, an address
inside it, or the article text). Crawling guardrails: robots.txt and AI-crawler opt-outs,
`noai`/`noindex` and mining reservations, paywalls kept to headline and link, crawl-delay,
back-off, and no Facebook, Nextdoor, Instagram, X, Reddit, TikTok or Legacy.com.

## Sections, ranking and writing

- **Sections:** events, council and government, schools and youth, local sports, police fire and safety,
  real estate, business, obituaries, community, weather and other news. Copies of one story
  from different sources are merged and every source is credited.
- **Ranking (v5, per section):** rules order each section, the model rates its top 15, a
  per-community bandit learns what readers open and share, an editor-style pass reorders,
  and a variety pass limits one source to 3 per section. The top 10 per section are
  written; up to 5 per section are published.
- **Writing:** a light-model call extracts each story's details (people, places, numbers,
  what happened, a short quote, the next step), and the writer leads with them. Every draft
  is checked against the source. The **floor** keeps allegations worded as allegations, no
  names of minors or victims in crime stories, no house numbers (block level), and no
  suicide method details; crime, arrests, deaths and court cases are otherwise ordinary
  stories. Students and other minors may be named in a positive light.

## Pages

- **Journalist workspace:** global Newsroom overview and health, location workspaces
  (desk overview, location-scoped input/alert review, staged pipeline with logs and manual
  controls, editions, location details and source editing), Editorial inbox, Attention
  queue, and Operations. Source editing is under **Location details → Source network**.
- **Internal maps:** `/source-map` shows one funnel per run, from the first search to the final
  edition, for either flow: who decided, when and why at each stage, one item's full trail, topic
  coverage, cost per service and a comparison of two runs, plus the source network.
  `/interest-usage` shows distinct edition-view,
  subscription-signup and interest-signup metrics on a geographic heat grid and exact-count
  table, with date/location filters and explicit history limits. Both are independently
  reachable with only `NEWSBEE_INTERNAL_PASSWORD`, including on localhost; without it
  they fail closed. Maps are read-only; source editing and pipeline controls remain in
  the administrator-only journalist workspace.
- **Model usage** (`/model-usage`, administrator-only): calls, reported input/output
  tokens and estimated USD cost by actual model, location, pipeline role and UTC day,
  with rolling 24-hour/7-day/30-day filters. Historical calls without location stay
  unassigned; missing tokens or prices are excluded from the priced subtotal, not
  assumed free. Configure both per-model input/output rates or exact-model
  `NEWSBEE_MODEL_PRICING` overrides; see [pricing and limits](Docs/deployment.md#model-usage-pricing).
- **Reader site** (`/reader`): community search and published editions, source-link dropdown,
  source suggestions, story sharing/reporting, weekly-update signup and family remembrances.
  Internal source decisions are not rendered or linked publicly.

## Develop and deploy

```text
npm --prefix apps/journalist-site run lint
npm --prefix apps/reader-site run check
npm --prefix apps/journalist-site test   # includes isolated, in-memory MongoDB workspace tests
npm --prefix apps/journalist-site run build
npm --prefix apps/reader-site run build
```

The first MongoDB-backed test run may download a MongoDB binary. These checks do not
prove live source availability, provider billing accuracy or production credentials.

Both apps deploy as one Vercel project from the repository root (only `main` deploys;
previews are off). See [Docs/deployment.md](Docs/deployment.md) for environment variables
and Drive setup, the [journalist guide](apps/journalist-site/README.md) and the
[reader guide](apps/reader-site/README.md). The earlier Python prototype is archived in
[archive/python](archive/python/README.md).
