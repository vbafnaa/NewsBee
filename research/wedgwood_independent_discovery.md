# Independent school, library and community discovery

Follow-up evaluation on November 6, 2026 (Pacific time). This replaces the earlier conclusion that the available independent run matched only three registry endpoints. Earlier run evidence remains unchanged.

## Why the previous changes stopped at three

The earlier code could follow pages once it knew a website, but lacked reliable institution starting points. Its OSM job timed out. The ungrounded local model invented several school/community domains; the correct PTA suggestion was rejected by crawler access policy. Paid/keyed search was unavailable and the current flow did not execute operator search. The strict inside-neighborhood OSM rule would also exclude some nearby serving institutions. The three exact matches were mainly supplied by existing newsroom/open-data/athletics discovery, not school/library/community discovery.

## What changed

A new `directories` mapping method is registered in the normal pipeline. For Seattle, WA, it starts with three **citywide official directories**, not neighborhood-specific URLs:

- [Seattle Public Schools directory](https://www.seattleschools.org/schools/): match the selected neighborhood name to school directory labels, extract the actual school website, then follow observed calendar/news/newsletter links. School domain names are never guessed.
- [Seattle Public Library locations](https://www.spl.org/hours-and-locations): visit the published branch links, extract official branch coordinates, rank branches within 3 km of the selected location center, and retain up to two. Follow only event links belonging to that branch. “Nearby serving branch” is an explicit candidate-selection heuristic, not a claim of assigned service coverage or inside-neighborhood location.
- [Seattle Department of Neighborhoods organization directories](https://www.seattle.gov/neighborhoods/community-connections/community-engagement/community-engagement-coordinators): follow the district PDFs linked by that page, match visible organization names to the neighborhood, resolve the corresponding PDF link annotations, and follow the resulting organization's actual navigation.

The adapter is Seattle-specific; it does not pretend to discover every city's directories. Its citywide entry points were verified from public authority websites during implementation. No Wedgwood school, council or branch endpoint is hard-coded in the implementation. Other municipalities need their own authority-directory configuration or discovery method.

All requests use the existing guarded public-source fetcher. Bounds cover response size, directory/page counts, child links and elapsed time. Failures are recorded without discarding other successful directory results. Every candidate retains its directory → institution → page chain. `inside_area` stays false, so later item-level locality checks remain required. A reachable source page is not automatically a recent story.

## Clean evaluation

Mapping run: `de92aae7-453b-452b-a5d1-812347a1a574`.

A separate database, `wedgwood_independent`, started with zero source records, no previous run records, no imported source discovery cache and no manual links. Only the prior geographic profile for Wedgwood was inserted. The human registry and the 28 assisted additions were not loaded. Normal pipeline execution may import its bundled public census/library reference catalogs. The three new directory paths do not read those catalogs or any source database.

The registry may be used **after discovery** for endpoint matching, never as a discovery input. [Initial-state evidence](evidence/directory_independent/initial_state.json) records this separation.

Configuration: manual/current mapping and collection, strict/respectful access, no paid providers or hosted search keys, local `qwen2.5-coder:latest`. The new directory method is deterministic and does not call the model. Location center: 47.690221,-122.2905745; approximate bbox remains the original Wedgwood profile. No articles are authored or published.

## Observed directory results

The live method completed in about 38 seconds and added **12 distinct institution endpoints** with no directory-fetch rejection:

| Institution | Independently discovered pages |
| --- | --- |
| Wedgwood Elementary | Homepage, calendar, news, school-hosted PTA newsletter |
| Northeast Branch | Branch information and branch-specific events |
| Green Lake Branch | Branch information and branch-specific events; nearby candidate, not assumed Wedgwood-local |
| Wedgwood community organizations | Community Council homepage, meetings, newsletter, Block Watch |

Northeast Branch was selected from its published coordinates at approximately **1.36 km** from the location center. Green Lake Branch was approximately 2.87 km away. The council was reached through an actual link annotation in the city's District 4 organization PDF. These links were found independently even though some later match registry URLs.

The school-hosted PTA newsletter is a distinct endpoint from the external PTA newsletter website in the registry. It must not be counted as an exact match to that external website. Finding the library branch page also does not recover its physical noticeboard or archive contents.

## Endpoint comparison after discovery

The complete clean map contains **47 source records**, including the **12 directory-derived endpoints**. Post-run matching against the registry finds **8 exact endpoints**, up from 3 in the earlier independent run. The five new endpoint matches are the school calendar, library events, WCC homepage, WCC meetings and the library branch information URL. The last is only a reference-page match: the registry's physical bulletin boards/binder were not digitized or discovered.

That means **four additional researched content endpoints plus one branch reference URL**, not five newly verified news feeds. The other directory endpoints are additional automatic discoveries outside the exact registry list. [Match evidence](evidence/directory_independent/endpoint_matches.json).

[All 12 independently found institution endpoints and provenance](wedgwood_independent_sources.csv). [Mapping and collection run records](evidence/directory_independent/pipeline_runs.json). [Directory decisions](evidence/directory_independent/run_decisions.json). [Implementation snapshot and hashes](evidence/directory_independent/implementation.json).

## Validation and remaining limits

All **18 discovery tests** pass, including a complete mocked directory discovery that fails if any source database is read, visible-label/PDF-link binding, alternate school names/domains, branch scoping, geographic exclusion and partial failure. TypeScript checking (`npm run lint`) passes. Earlier model-readiness and linked-page regressions remain included. Live results above come from real public pages, not test fixtures.

The current school selection finds neighborhood-named schools; it does not yet infer school attendance boundaries or discover every differently named school serving the neighborhood. Nearby library selection requires service-area review. Directory HTML/PDF changes can require adapter maintenance. Publication dates, duplicate story identities, event-feed completeness and central item locality still need downstream validation. Existing OSM/model limitations are independent of this new path.

Code: `apps/journalist-site/pipeline/discovery/directories.ts`, registration in `discovery/methods.ts`, method label/type in `sourcemap/store.ts`, and `pipeline/tests/discovery/directories.test.ts`. Changes are local and uncommitted; nothing was deployed.

## Completed collection check

Collection run `5030d2a8-2801-424f-bd67-61e16600f525` completed all **41 source tasks** and stopped at `awaiting_authoring`. All 12 directory-derived endpoints were attempted. The four WCC endpoints each returned 5 candidate records (20 records with substantial shared-feed overlap), including the board meeting, land-use event and restroom renovation update. These are still flagged for central locality checks. Do not interpret those 20 records as 20 unique stories or as four independently different feeds.

The four school endpoints and four library endpoints each retained **zero candidates** in this collection window. This implementation fixes independent source discovery; native school/library calendar extraction remains unresolved. Zero retained items does not establish that those institutions have no events. [Per-source collection outcomes](wedgwood_independent_collection.csv) preserve the reader details.

Across all sources, this clean collection retained **78** candidate records, **75** pending central locality checks. The remaining three are the permit/fire connector-local updates seen previously. No authoring, central locality decision or publication was triggered. [Final counts](evidence/directory_independent/final_counts.json).
