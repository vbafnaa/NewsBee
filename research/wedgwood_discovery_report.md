# Wedgwood human vs. automated discovery: completed local comparison

> Latest follow-up: [Independent institution discovery](wedgwood_independent_discovery.md) adds a clean, registry-free run using official citywide directories. Earlier run counts below are preserved.

> Follow-up: local implementation changes and separate unseeded/registry-assisted reruns are documented in [Pipeline improvements and recovery](wedgwood_pipeline_improvements.md). The counts below remain the original M1/C1 baseline.

Assessment: November 6, 2026, America/Los_Angeles. Repository: `eacb76e`, branch `shruthika-pipeline`. This report supersedes the earlier missing-input report.

**The existing registry was inventoried and Newsbee's actual mapping and collection pipeline was run locally.** This is a comparison against the two explicitly identified local runs below, not a claim about unavailable production runs. Mapping completed with two discovery-method failures; collection completed at the manual pre-authoring gate. No articles were authored or published and no production code was changed. The human registry was not fed to automated discovery, which would invalidate the baseline comparison.

## 1. Summary of human vs. machine coverage

| Measure | Count / interpretation |
| --- | --- |
| Original registry | 137 source-candidate rows |
| Shruthika rows | 23 (registry rows 34–56) |
| Chris rows | 12 (127–138), including nearby/conditional/archive leads |
| Overlapping Shruthika/Chris URLs | 3: WCC homepage, PTA homepage, Northeast Branch events |
| Deduplicated core inventory | 32 = 23 + 12 − 3 |
| Other teammates' relevant shared/conditional candidates | 27 rows, adding 19 unique endpoints |
| Total compared | **51 source candidates**, from 62 selected rows |
| Found by human and machine | **3**, including 1 of the 32 core sources |
| General website found, specific registered content absent | **11** |
| Human-only endpoints in these local runs | **37** |
| Unclassifiable endpoint presence in these completed local exports | 0; usefulness and production-run coverage still have unknowns |
| Machine source records | **22**, of which 12 have explicit website/dataset endpoints; remaining records are connector configurations |
| Retained collection candidates | **61**, before central locality/ranking/authoring |
| Connector-local updates | **3**: two permits and one aggregated fire/medic update |
| Collected candidates awaiting central locality checks | **58**; do not count these as confirmed Wedgwood stories |
| Published stories | **0**, intentionally |

The exact matches are **The Seattle Medium**, **King County Food Establishment Inspection Data (`r878-4sxa`)**, and **WIAA's feed**. Seattle Medium supplied 10 unreviewed article candidates; the other two retained no items. Therefore **no useful Wedgwood story from a matched human source has yet been confirmed**; this is not proof that all ten Medium candidates are irrelevant. The three connector-local updates came from machine-discovered Seattle permit and fire datasets, not exact registry endpoint matches.

The 51 denominator includes leads, regional sources, historical collections, physical notices and a restricted reference; it is not 51 verified current-news feeds. The 19 added endpoints are shared Seattle/King County/WA services or explicitly conditional regional publishers in teammates' entries. Their original Ballard/Beacon Hill filters must be replaced with Wedgwood filters. Generic national platform/API documentation and other-neighborhood-only institutions were excluded. Core and expanded counts are shown separately to avoid overstating neighborhood-specific research.

### Inventory and matching method

Input: user's `Pasted text.txt`, parsed as quoted tab-separated records, including embedded newlines. Source hash and all selected row numbers are in [inventory_manifest.json](evidence/inventory_manifest.json); original selected fields are in [human_registry_selected.json](evidence/human_registry_selected.json). Row numbers are logical spreadsheet rows, not physical text lines.

Deduplication retains contributing names and original URLs, strips terminal slashes and `www`, and merges same-host Socrata dataset aliases by dataset ID. Paths/feeds remain distinct: WCC meetings vs. news, PTA newsletter vs. homepage, park info vs. construction updates, police dashboard vs. dataset, library calendar vs. physical postings. Arrest-data rows 80/81/87 refer to one dataset; row 81's “Crisis Contact” label conflicts with its arrest URL and is flagged. No arbitrary subdomain or redirect equivalence was assumed.

An exact source/feed match is different from a host-only match. Endpoint absence is assessed against the complete local source snapshot, collection outcomes and checked-page/item records. “Human-only” means absent from these specific outputs, not absent from every Newsbee run, and not necessarily a missed eligible story. Specific causal rejection is unknown unless logs support it.

### Runs and reproducibility

| Run | ID | Configuration and outcome |
| --- | --- | --- |
| M1: mapping | `de205296-bceb-485f-9534-860024d17b57` | Nov 6, 15:59:51–16:01:23 PST; current flow, rebuild all methods, strict guardrails, respectful access, classifier off, paid services disabled; mapped with 22 records; 7 methods successful, 2 failed |
| C1: collection | `f0f092e9-e03b-4e1e-9c28-262ca5c06043` | Reads M1 map version 1; manual/current flow, same access/guardrails/topics; all 22 source tasks completed; stopped at `awaiting_authoring` |

Both runs used location `osm-r13915552-wa`, resolved by the real Photon/OSM geocoder, with approximate bbox `[-122.30808, 47.6830397, -122.2797623, 47.6975789]`. It is not a reviewed neighborhood polygon. Run `today` was 2026-11-06 and the saved edition/event window was November 7–13. Connectors apply their own lookup ranges: recent permit/fire/news data here looked back to October 30. Do not apply the future event window to all news items. C1 started November 6 at 16:02:00 PST and reached `awaiting_authoring`; `completed_at` remains null because the full edition was intentionally not authored/published.

M1 used the default Ollama `qwen3:4b`, which was missing. Before C1 the local server was restarted with already-installed `qwen2.5-coder:latest`; **M1 was not rerun**, so its missing-model discovery gap remains. No hosted/search API keys were configured; the saved search-provider option is `serpapi`, but current-flow mapping did not run the agentic operator-search method. Paid-call allowance was empty. No paid service or model download was used. The model names are supplemental launcher metadata because run options alone do not capture them.

The standard local launcher first hit sandbox socket restrictions; after authorized escalation it started but exited when the reader daemon exited. An isolated MongoDB on port 27028 and journalist server on 3001 were used instead. Early cross-origin POST attempts were rejected before onboarding/run creation; successful requests used the required Origin header. These startup attempts are not discovery runs.

Evidence: [M1 immutable snapshot](evidence/map_run_1/pipeline_runs.json), [M1 source map](evidence/map_run_1/source_map.json), [run records](evidence/pipeline_runs.json), [source outcomes](evidence/source_results.json), [all item records](evidence/collected_items.json), [job outcomes](evidence/pipeline_jobs.json), [decision trace](evidence/run_decisions.json). Historical production outputs were not located and production MongoDB credentials were unavailable. These fresh local results must not be relabeled as production history.

### What discovery actually found

| Machine source | Website/dataset or configuration | Discovery method in M1 | Retained candidates in C1 | Collection outcome |
| --- | --- | --- | ---: | --- |
| Food Establishment Inspection Data (Public Health - Seattle & King County) | https://data.kingcounty.gov/d/r878-4sxa | opendata |  | ingested |
| Seattle public meetings affecting Wedgwood | (connector; see parameters) | national |  | ingested |
| King County public meetings | https://kingcounty.legistar.com/ | meetings |  | ingested |
| City of Seattle | https://seattle.gov/ | government |  | ingested |
| King County | https://kingcounty.gov/ | government |  | ingested |
| Stories shared by Wedgwood neighbours | (connector; see parameters) | national |  | ingested |
| News search (GDELT) | (connector; see parameters) | national |  | ingested |
| Wikipedia-discovered local reporting | (connector; see parameters) | national |  | ingested |
| Community reporting links | (connector; see parameters) | national |  | failed |
| Seattle Weekly | https://www.seattleweekly.com/ | newsrooms | 12 | ingested |
| The Stranger | https://www.thestranger.com/ | newsrooms | 12 | ingested |
| Crosscut | https://crosscut.com/ | newsrooms | 15 | ingested |
| International Examiner | https://iexaminer.org/ | newsrooms | 9 | ingested |
| Seattle Medium | https://seattlemedium.com/ | newsrooms | 10 | ingested |
| Family-submitted remembrances | (connector; see parameters) | national |  | ingested |
| Building Permits (City of Seattle) | https://cos-data.seattle.gov/d/76t5-zqzr | opendata | 2 | ingested |
| U.S. Attorney's Office announcements | (connector; see parameters) | national |  | ingested |
| Seattle Real Time Fire 911 Calls (City of Seattle) | https://cos-data.seattle.gov/d/kzjm-xkqj | opendata | 1 | ingested |
| Washington Interscholastic Activities Association | https://www.wiaa.com/ | athletics |  | ingested |
| National Weather Service alerts | (connector; see parameters) | national |  | ingested |
| USGS earthquakes nearby | (connector; see parameters) | national |  | ingested |
| Drinking water safety (EPA) | (connector; see parameters) | national |  | ingested |

National/reader connectors are registered capabilities, not discovered source websites or stories. In particular family notices and reader submissions were empty. All 22 collection jobs completed, but the Bluesky connector outcome was `failed: All linked reporting unavailable`; a completed job does not mean successful ingestion. The King County meeting candidate exists, but checked-page records indicate the meeting collection used Seattle's Legistar context; its tenant-to-reader wiring needs investigation before claiming verified King County agenda coverage.

### Actual updates and stories

The complete list of retained candidates, titles, URLs, dates, source IDs and run IDs is [wedgwood_machine_items.csv](wedgwood_machine_items.csv). There are 61 distinct retained item records; record identity includes `source_event_id`, so the two permit records are not incorrectly collapsed merely because they link to the same dataset. No cross-run pooling was used.

The three potentially useful neighborhood updates are:

1. **Building at the 8000 block of 27TH AVE NE**, November 3: window/door replacement permit. Connector classified it local by approximate-area coordinates.
2. **Demolition at the 2700 block of NE 92ND ST**, November 2: residential demolition permit, also approximate-area matched. Both use [Seattle building permits](https://cos-data.seattle.gov/d/76t5-zqzr). Values are estimated project values, not home sale prices.
3. **Fire and medic calls in Wedgwood since October 30**, November 6: one aggregate update summarizing six calls from [Seattle fire-call data](https://cos-data.seattle.gov/d/kzjm-xkqj). Six calls are not six stories, and calls are not confirmed crimes. The raw label says boundary, but the configured boundary is an approximate bbox.

These are pipeline-collected reporting inputs, not independently verified published articles. Other retained items include Seattle Medium's “Lincoln Stuns Franklin 24-20 In Regular Season Finale” and International Examiner's “November 2026 Events Calendar”; their presence illustrates broad candidate collection, not demonstrated Wedgwood relevance.

The audit contains 683 dropped records, but some are aggregate skip-counter placeholders, so that number must not be called a rejected-story count. No final locality/ranking shortlist was produced because the run intentionally stopped before authoring. C1's 61 raw candidates are not 61 neighborhood stories.

## 2. Coverage gaps by category

Counts below are multi-label source counts; rows can cover more than one category and must not be summed to 51. Regional/history candidates are also retained in the CSV.

| Category | Human candidates | Exact source matches |
| --- | ---: | ---: |
| Events | 15 | 0 |
| Government and council | 8 | 0 |
| Schools | 4 | 0 |
| Crime and safety | 10 | 0 |
| Home sales | 7 | 0 |
| Businesses | 3 | 1 |
| Community organizations | 9 | 0 |
| Sports | 5 | 1 |
| Obituaries | 7 | 0 |

- **Events, schools and community organizations — largest practical gap.** WCC, its meetings page, school calendar, PTA homepage/newsletter, Northeast Branch events, REconomy, Lifetime Learning and Eckstein are absent as exact sources. Failed institution/model discovery and missing library selection are documented. This does not establish that each page held an eligible story during C1's window.
- **Government and council.** Seattle's general website and meeting platform were found, but the registered park/project pages and neighborhood council were not. Seattle's root crawler visited five unrelated pages; it did not establish discovery of Dahl/Wedgwood project updates. Meeting checks recorded cancelled/outside-community exclusions, not a universal absence of meetings.
- **Crime and safety.** The human police map, blotter, incident-report and crime/arrest endpoints were not exact matches. The machine did find fire-call data and produced one local summary. Do not claim all safety coverage was missed. The DOJ national sample is not proof it discovered the registry's specific Western Washington press-release page.
- **Home sales.** No registered assessor sales/parcel endpoint was found. The two permit updates do not close the home-sales gap. The county homepage was found but its limited crawl visited other departments; source-map property discovery did not produce a sales source.
- **Businesses.** The machine found the shared food-inspection dataset but retained zero local items. WCC-linked business updates and licensing actions need dedicated address/entity discovery; a permit or license alone is not proof of an opening.
- **Sports.** WIAA's exact feed was found but retained zero items; local Roosevelt/Nathan Hale/team/booster endpoints were absent. A regional football headline still requires team/service-area relevance review.
- **Obituaries.** No public obituary endpoint in the human list was found. The family-submission connector had zero approved notices. WA death records are explicitly a restricted reference, not a feed to force into automation.

## 3. Evidence-supported misses and causes

These are **observed endpoint gaps in M1/C1**, not verified counts of lost stories. Every CSV row records source-specific evidence and a proposed fix.

| Method | Successful | Candidates found | Actual detail |
| --- | --- | ---: | --- |
| national | True | 10 | 10 national and onboarding sources |
| meetings | True | 1 | Seattle and King County: 1 accounts found |
| publishers | True |  | 0 publishers with 2+ results; 0 added |
| llm |  |  | Error: Model request failed (404): {"error":"model 'qwen3:4b' not found"} |
| government | True | 2 | city site, King County; 2 sources |
| opendata | True | 3 | 4 portals (cos-data.seattle.gov, performance.seattle.gov, data.kingcounty.gov, data.wa.gov); 3 datasets |
| athletics | True | 1 | 1 associations with a current feed |
| newsrooms | True | 5 | 5 newsrooms with a current feed |
| osm |  |  | TimeoutError: The operation was aborted due to timeout |

The strongest causes supported by evidence are the missing mapping model, timed-out OSM institution lookup, no selected library branches, limited root-site traversal, and no paid/agentic web search in this configuration. It is an inference that these failures explain individual WCC/PTA/school misses: no per-source rejection trace establishes that chain. Sources absent from the map were never passed to collection.

Northeast Branch's listed latitude is south of the provider bbox: the calendar can be useful to Wedgwood residents without being geographically inside this run's area. Physical boards/binders and historical clippings are a different access gap. Chris actually inspected them; a library homepage cannot supply those documents. Nextdoor's member feed was never verified in the registry, and the current discovery prompt excludes Nextdoor. Neither that nor the restricted death-record reference should be treated as a known accessible current-story loss.

## 4. Repeatable human discovery techniques and website checks

Shruthika's rows generally record **access methods**, not original search paths; the CSV says original discovery route not recorded rather than inventing queries. Chris's notes document a library visit, inspected/photographed boards and clippings, staff mentions and calendar review. These methods expose service-area and offline sources that geographic website discovery can miss.

1. School homepage → calendar → subscription options; school/parent links → PTA → dated newsletter issues. [Wedgwood Elementary's instructions](https://wedgwoodes.seattleschools.org/news/school-calendar/) document calendar subscription. [The PTA newsletter index](https://www.wedgwoodpta.org/newsletter) exposes dated issues and separate calendar links. Neither check proves an eligible story in C1's window; feed payloads still need testing.
2. Library branch → branch events, not city-wide events. The [Northeast calendar](https://www.spl.org/hours-and-locations/northeast-branch/northeast-branch-events) is accessible, but extracted text did not expose an event payload. Inspect the published calendar integration and authorized feed before promising automated extraction; add a reviewed nearby-service branch rule.
3. Community council → original dated announcements → linked business/organization pages. The [October WCC meeting post](https://www.wedgwoodcc.org/2026/10/05/join-us-for-our-october-2026-board-meeting-via-zoom-october-6-730-830pm/) demonstrates business and land-use links, but is outside the recent-data window and is not counted as a missed current story.
4. Physical flyer/staff interview → organizer identity → original calendar or confirmed intake. [REconomy's events page](https://seattlereconomy.org/events/) exposes class/event navigation and different library venues. Preserve NE Seattle vs. Shoreline location, registration, fees and cancellations. A webpage check is not an extraction test.
5. Official records directory → documented dataset → dates/coordinates/parcel join. The [King County assessment download page](https://info.kingcounty.gov/assessor/DataDownload/default.aspx) was reachable, but this audit did not validate a sales-file schema or download. Test the registry's extracts/eSales/parcel paths rather than promising an unverified API. For police, resolve and validate the registry's dataset IDs, then geographically filter incident records rather than applying a broad Seattle keyword.

Public checks were method validation only, separate from Newsbee run evidence. Web tool access differed from pipeline HTTP access (for example earlier police-dashboard retrieval was 403); one client's failure is not evidence of another client's rejection.

## 5. Five highest-priority pipeline improvements

1. **Fail early on provider readiness and expose method failures.** Validate configured model existence and actual search access before mapping. Retry transient OSM failures and surface degraded mapping prominently; “mapped” and completed jobs currently coexist with failed methods. Acceptance: valid model probe, per-method status and immutable run/config snapshots.
2. **Discover institution-specific content endpoints.** Traverse school/PTA/newsletter, library calendar, council meetings/news and park project pages; preserve multiple endpoints on shared domains. Root crawls visited unrelated pages in this run. Acceptance: exact expected endpoint coverage and dated local items, not domain hits. Keep a seeded evaluation separate from unseeded discovery.
3. **Represent neighborhood service areas as well as geography.** Review Wedgwood's bbox and explicitly allow nearby branches/schools serving residents, with reasons; do not indiscriminately widen to all Seattle. Add organizer-assisted intake for offline notices. Acceptance: Northeast Branch events can be considered while unrelated branches remain excluded.
4. **Add and validate structured police, sales and business sources.** Resolve current dataset schemas, join sale records to parcels, filter dates/coordinates and track source-specific failures. Preserve sales vs. permits, calls vs. crimes, licensing vs. openings. Acceptance: traceable eligible records with correct labels and locality evidence.
5. **Evaluate all nine coverage categories using useful items.** Expand directed discovery beyond the five priority topics and track government, schools, businesses and community organizations explicitly. Report source recall, raw candidates, locality-confirmed inputs and publication separately. Acceptance: 58 pending-locality articles cannot be reported as 58 Wedgwood stories; every failed/empty source retains an explanation.

## 6. Remaining uncertainty and limits

Production history remains unavailable. This was a free-provider current-flow run with a failed mapping model, not a representative test of a fully configured agentic/paid run. The source inventory is complete for the documented inclusion rule; regional relevance, lead freshness, physical materials and original discovery methods remain partly unverified. No dated human story set exists, so story recall and counts of lost eligible stories cannot be calculated.

Central locality evaluation, deduplication/ranking and editorial verification have not run. Three records are connector-local candidates under approximate geography, not final editorial approvals. The source-results detail for each connector is authoritative about its limited sample, not exhaustive coverage of that source. Raw dataset freshness, calendar payloads, restricted-source access, and per-source causal explanations require further validation. All human-only/general-site classifications are scoped to the saved M1/C1 outputs.

Artifacts: [comparison CSV](wedgwood_human_vs_auto.csv), [retained machine candidates](wedgwood_machine_items.csv), and [export manifest](evidence/export_manifest.json). No production code changes, manual source seeding, authoring or publication were performed.
