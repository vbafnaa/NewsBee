# Wedgwood pipeline improvements and measured recovery

> Latest follow-up: [Independent institution discovery](wedgwood_independent_discovery.md) adds a clean, registry-free run using official citywide directories. Earlier run counts below are preserved.

Follow-up to the baseline comparison, November 6, 2026 (Pacific time). Changes and tests were applied locally at the user's request; nothing was deployed, authored or published. The baseline exports remain unchanged.

## Implemented improvements

1. **Make model failures explicit.** Discovery checks local model readiness before generation. The evaluation launcher now uses the already-installed `qwen2.5-coder:latest`; it previously requested absent `qwen3:4b`. No model download or paid provider was used.
2. **Follow actual source navigation.** Government and model-proposed websites now yield bounded, fetched calendar/news/project/lookup pages from observed same-site links. Neighborhood-named links receive priority; guessed paths are not added by this helper. Thin, stale dated and inaccessible pages are rejected with evidence. Undated/lookup pages remain reference-only. The live run added 13 pages, many municipal service pages; this is not 13 new neighborhood news feeds.
3. **Preserve distinct endpoints and explicit additions.** Specific validated navigation pages use the existing 12-page host allowance; generic roots retain the normal cap. Explicit pinned editor additions no longer disappear behind the automatic per-host cap. Calendar, meetings and homepage URLs retain separate identities.
4. **Improve category coverage without weakening locality.** School calendars, PTA, councils, organizations and business-record searches are placed early enough for the normal 36-query budget. Model assertions and a parent-city mention no longer mark every item as inside Wedgwood. The query-budget change is unit-tested; the current-flow live run did not exercise keyed agentic web search.
5. **Use the existing research as a transparent assisted fallback.** `validate_registry_sources.mjs` submits public registry endpoints to the existing source-intake validator, records each result and leaves locality checks enabled. It skips existing automatic matches, undocumented obituary permissions, physical/historical sources and unestablished restricted access. These additions are explicitly human-assisted, not independent discovery.

Implementation: `pipeline/discovery/methods.ts`, `linked-pages.ts`, `topics.ts`, `pipeline/sourcemap/store.ts` under `apps/journalist-site`; `research/validate_registry_sources.mjs`. Code remains uncommitted. TypeScript checking (`npm run lint`) passed, as did 29 targeted discovery/provider tests and 30 source-intake/internal-access/orchestration regression tests; `git diff --check` passed.

## Runs kept separate

| Stage | Run ID | Source result | Story/update candidates |
| --- | --- | --- | --- |
| Baseline M1 + C1 | `de205296-bceb-485f-9534-860024d17b57`; `f0f092e9-e03b-4e1e-9c28-262ca5c06043` | 22 map records; 3/51 exact registry matches | 61 retained: 3 connector-local updates, 58 needing locality checks |
| Improved unseeded M2 + C2 | `f3541a5c-5b52-483b-8f58-fe23f0f45f5b`; `9cf376a7-303c-45ae-a9b8-5c1c86892b0b` | 35 cumulative map records, 13 additions; 3/51 exact matches; 29 collection tasks | 58 retained: 3 connector-local updates, 55 needing locality checks |
| Registry-assisted intake + C3 | intake result per URL; `7ed77593-d9c8-4be7-b35e-5e0bb75e1e48` | 63 cumulative map records; 28 newly accepted registry endpoints; 31/51 exact matches | 105 retained candidate records; 101 needing locality checks |

All use location `osm-r13915552-wa`, Wedgwood, Seattle; center 47.690221,-122.2905745 and approximate bbox [-122.30808,47.6830397,-122.2797623,47.6975789]. This tests that configured neighborhood, not every individual venue address or a reviewed service-area polygon. Manual/current flow, strict/respectful access, classifier off, paid providers disabled, no hosted search keys; topics crime/deaths/events/home_sales/sports. Event window November 7–13; some record connectors look back to October 30. C3 completed all 57 source tasks and stopped at `awaiting_authoring`. No central locality/authoring run was triggered. C1 and C2 were cancelled only after capturing their completed collection at `awaiting_authoring`, to release the gate for the next run.

M2 reuses the unseeded baseline map; it is an incremental rebuild, not a fresh empty-database recall experiment. Its model method succeeded; OSM institution discovery still timed out. It suggested the correct PTA homepage but access policy rejected it, so that is a discovered lead, not an accepted source. No new exact registry endpoint was independently accepted. The additional King County eSales entry page is not the exact residential-search endpoint in the registry.

## Recovered sources and content

The intake attempted 37 URLs: **28 accepted, 9 rejected**. Fourteen were not attempted: 3 already matched, 7 obituary/vital-record references with no documented permission for that intake path, 2 physical/archive library references, 1 historical blog and 1 restricted discussion feed. This leaves **20 of the 51 registry endpoints unrepresented**: 9 rejected and 11 deliberately not attempted. 'Accepted' means the intake validator saved the source; it is not confirmation of recent useful Wedgwood content.

| Accepted source | Preview candidate records | C3 retained candidate records |
| --- | ---: | ---: |
| WCC news / Wedgwood Community Council | 5 | 5 |
| WCC meetings | 5 | 5 |
| Wedgwood Elementary calendar | 0 | 0 |
| Northeast Library events / Seattle Public Library — Northeast Branch events | 0 | 0 |
| Dahl Playfield | 0 | 0 |
| Dahl restroom project | 0 | 0 |
| KC home sales / King County eSales residential search | 0 | 0 |
| KC property lookup | 0 | 0 |
| SPD crime maps | 0 | 0 |
| SPD incident reports / SPD Significant Incident Reports | 8 | 8 |
| SPD open data | 0 | 0 |
| SPD crime dashboard / Crime Dashboard | 0 | 0 |
| Roosevelt sports | 0 | 0 |
| Nathan Hale sports | 0 | 0 |
| Seattle schools athletics | 0 | 0 |
| SDOT current projects | 0 | 0 |
| King County Metro service alerts | 0 | 0 |
| WA LCB New License Actions | 0 | 0 |
| SPD Crime Data: 2008-Present (data.seattle.gov) / SPD Crime Data: 2008-Present | 1 | 1 |
| Arrest Dashboard / Crisis Contact / SPD Arrest Data | 0 | 0 |
| Seattle Fire Real-Time 911 | 0 | 0 |
| SPD Blotter RSS | 3 | 3 |
| King County Prosecuting Attorney official updates | 0 | 0 |
| King County Assessor sales extracts | 0 | 0 |
| King County Recorder's Office | 0 | 0 |
| Seattle REconomy / NE Seattle Tool Library | 25 | 25 |
| Lifetime Learning Center | 0 | 0 |
| Eckstein (school source; endpoint unconfirmed) | 0 | 0 |

Preview counts are not added to collection counts. Distinct endpoints can yield the same feed and duplicate stories: the WCC homepage and meetings page can both return the council feed, so a meeting-page acceptance does not prove a newly discovered meeting. C3 has 96 distinct item URLs, which is also not a definitive unique-story count (dataset URLs can represent multiple updates). See [retained candidate export](wedgwood_assisted_items.csv) for titles and locality flags. No human-registry entry is counted as a story merely because its website exists.

### Concrete recovered candidates

C3 retained the WCC November 10 board-meeting announcement, November 9 land-use event and November 2 Dahl Field restroom update. These are candidates with identifiable titles and URLs, still marked for central locality checks; the October 31 trick-or-treat item is retrospective, not an upcoming November 7–13 event. WCC homepage/meeting-page and RSS/canonical URL overlap must be deduplicated. The crime dataset produced one boundary-filtered aggregate police update, bringing connector-local update records to four (not four individual incidents). The other 101 retained records remain pending locality checks.

## Observed blockers

- [https://www.wedgwoodpta.org/newsletter](https://www.wedgwoodpta.org/newsletter): Link is not usable: site opts out of AI crawlers in robots.txt (ClaudeBot): https://www.wedgwoodpta.org/newsletter
- [https://www.wedgwoodpta.org/](https://www.wedgwoodpta.org/): Link is not usable: site opts out of AI crawlers in robots.txt (ClaudeBot): https://www.wedgwoodpta.org/
- [https://legacywww.seattle.gov/parks/about-us/projects/wedgwood-landbanked-site-park-development](https://legacywww.seattle.gov/parks/about-us/projects/wedgwood-landbanked-site-park-development): Link is not usable: Error: Homepage could not be read: https://legacywww.seattle.gov/parks/about-us/projects/wedgwood-landbanked-site-park-development (TypeError)
- [https://gis-kingcounty.opendata.arcgis.com/](https://gis-kingcounty.opendata.arcgis.com/): Link is not usable: crawl-delay of 60s is longer than 5s: https://gis-kingcounty.opendata.arcgis.com/
- [https://www.rooseveltathleticboosters.org/page/show/3588212-teams-and-contact-information](https://www.rooseveltathleticboosters.org/page/show/3588212-teams-and-contact-information): Link is not usable: site opts out of AI crawlers in robots.txt (ClaudeBot): https://www.rooseveltathleticboosters.org/page/show/3588212-teams-and-contact-information
- [https://www.justice.gov/usao-wdwa/pr](https://www.justice.gov/usao-wdwa/pr): Link is not usable: crawl-delay of 10s is longer than 5s: https://www.justice.gov/usao-wdwa/pr
- [https://blue.kingcounty.com/Assessor/eRealProperty/default.aspx](https://blue.kingcounty.com/Assessor/eRealProperty/default.aspx): Link is not usable: Site opts out of reuse (noindex, noai or a mining reservation)
- [https://gisdata.kingcounty.gov/](https://gisdata.kingcounty.gov/): Link is not usable: crawl-delay of 60s is longer than 5s: https://gisdata.kingcounty.gov/
- [https://northeastdistrictcouncil.wordpress.com/about/](https://northeastdistrictcouncil.wordpress.com/about/): Link is not usable: Error: Homepage could not be read: https://northeastdistrictcouncil.wordpress.com/about/ (Error)

The implementation respects these failures; no robots or reuse restriction was bypassed. Recorded crawl-delay refusals could be addressed by a compliant slower scheduler, not by reducing the site's stated delay. Failed/legacy URLs need a verified replacement. Restricted or offline material needs an authorized feed or human contribution route.

## Five highest-priority next improvements

1. **Ground institution discovery in authoritative directories.** Use Seattle Public Schools school/PTA links, SPL branches and municipal community-organization directories before asking a model for URLs. Make OSM timeouts retryable with bounded fallback. The ungrounded local model invented several institution domains; this is the biggest remaining automatic-recall gap.
2. **Add native calendar/feed readers.** Resolve the Northeast Branch's actual event feed and school calendar exports, preserving branch/venue IDs. These saved pages returned zero preview items; accepting HTML is insufficient. Review nearby serving institutions separately from strict neighborhood geometry.
3. **Implement structured property and police queries.** Read documented sales/parcel exports and supported police schemas, apply a reviewed neighborhood boundary plus dates, and retain query/coordinate evidence. The eSales form returned zero items. The police dataset test must be checked for schema and row-limit completeness before claiming comprehensive coverage.
4. **Separate source usefulness from reachability.** Rank neighborhood news/calendars above generic municipal service navigation; retain a canonical story key across feeds and pages, and evaluate item-level locality before calling a candidate useful. Add a fixed registry regression set with independent vs assisted provenance.
5. **Provide compliant access fallbacks.** Queue requests at stated crawl delays; use authorized subscriptions/feeds for PTA and blocked sources, permission-backed obituary intake and human submissions for physical notices. Show explicit blocked/not-attempted reasons rather than treating all absences as discovery misses.

## Evidence and limits

[Source-by-source results](wedgwood_source_recovery.csv), [intake responses](evidence/assisted_validation/results.json), [independent map](evidence/improved_independent/source_map.json), [independent decisions](evidence/improved_independent/run_decisions.json), [assisted source outcomes](evidence/assisted_validation/source_results.json), [assisted run records](evidence/assisted_validation/pipeline_runs.json), [counts](evidence/recovery_counts.json). Baseline comparison: [report](wedgwood_discovery_report.md), [CSV](wedgwood_human_vs_auto.csv).

Production coverage, a reviewed boundary, per-venue geographic correctness, remaining item locality, source permission where absent, event-feed completeness and final unique useful-story counts remain unverified. This evaluation demonstrates local discovery and collection behavior, not production readiness or publication approval.

Implementation/run metadata and source hashes: [execution configuration](evidence/improvement_execution_configuration.json); [reviewable patch](evidence/improvement_changes.patch).
