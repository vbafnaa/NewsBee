# Production readiness and non-OSM source audit

Assessment: November 6, 2026, Pacific time. This is a code/build and saved live-run audit, not a test against production credentials or production networking. No deployment was performed.

## Production assessment

The optimized Next.js production build completed successfully, including type checking and build tracing. Existing warnings concern CSS alignment compatibility and the local queue client's default region. The pipeline advance, queue and collection routes declare 300-second maximum duration. The repaired OSM standalone request took about 76 seconds, with bounded attempts; it fits that declared discovery-job duration. The 75-second collection-reader cutoff is a separate path and does not govern discovery jobs. Actual hosting-plan limits, outbound access from the deployment region, provider availability and production credentials remain unverified. Public endpoints do not provide a reliability guarantee.

The OSM helper uses normal server-side HTTPS GET and no local-only runtime dependency. Its refusal cooldown currently lives in process memory and is not shared across serverless instances. Production-wide rate limiting/cooldown persistence remains a follow-up. The directory adapter's PDF dependency was included in the successful build, but production execution was not exercised.

Cloud mode defaults to hosted Gemini and rejects Ollama. Local model results do not validate Gemini grounding. Hosted keys and paid-call permissions must be configured for the intended production AI/search path. These settings were not inspected on the deployed service.

## Non-OSM results

Evidence: clean mapping run `de92aae7-453b-452b-a5d1-812347a1a574` and collection run `5030d2a8-2801-424f-bd67-61e16600f525`. These existing live runs are reused rather than presented as new tests. All nine non-OSM discovery methods completed; 'completed' does not imply useful coverage. Publishers found zero qualifying outlets in the fresh history database. Operator search was not enabled in current flow. The 41 collection outcomes are individually recorded in [source-health CSV](wedgwood_source_health_audit.csv).

- **Produced data:** permit and fire datasets retained three connector-local updates. Five newsroom feeds returned 55 candidates awaiting locality checks. Four WCC endpoints returned 20 records with shared-feed duplication; these also await locality review.
- **School/library extraction incomplete:** eight institution endpoints were reached but retained zero items. Their dropped-page evidence says `undated` (39 records total). This is not evidence of no available school/library events.
- **GDELT failure hidden:** all three topic searches show `fetch failed` in `pages_checked`, yet the connector reports `ingested` and zero results. Code catches each query failure and returns the normal empty result. It also treats a non-JSON response as an empty result. Do not classify this as a healthy empty search. This audit identifies the bug; it has not changed that connector.
- **Community reporting failed:** the `trending:bluesky` source reports `All linked reporting unavailable`. The connector's name covers a broader search-and-linked-page flow; this alone does not prove the Bluesky API itself failed.
- **Meetings APIs returned records:** Seattle records were excluded as cancelled (4) or outside-community (5); King County records as cancelled (1) or outside-community (11). Requests worked, but geographic relevance filtering needs review before claiming comprehensive council coverage.
- **Other zero results:** inspection data read 411 rows and retained none; EPA checked systems without a local match; NWS and USGS returned no qualifying alerts/events; Wikipedia topics were not trending. These are observed outcomes, not comprehensive recall tests.
- **Justice coverage limited:** the reader inspected 50 national releases and found no Washington U.S. Attorney releases. It should not be described as exhaustive local DOJ coverage.
- **Submissions:** neighbor and family-notice readers had zero approved submissions. That is not a retrieval failure.

## Priorities before a production claim

1. Make failed/partial GDELT queries distinguishable from successful empty results and add a tested search fallback.
2. Implement school/library calendar extraction and verify against known dated events.
3. Diagnose failed community-reporting links individually.
4. Review locality exclusions and duplicate feeds; validate coverage with dated neighborhood fixtures.
5. Run a bounded deployed smoke test with actual hosted-model/search credentials and shared provider rate controls before claiming production reliability.

No new provider was enabled, no paid request was made, and no articles were authored or published during this audit.

## Remaining provider audit — follow-up

Fresh public endpoint checks on November 6, 2026 (Pacific time): **GDELT returned HTTP 429**, while **Bluesky search returned HTTP 200 and five posts**. No retry was issued after the rate limit. This distinguishes the earlier community-reporting linked-article failure from the health of the Bluesky API itself.

Gemini, Tavily, SerpApi, SearchApi, Bright Data, Exa and ATTOM credentials are absent from the current process and conventional project/app local env files. They cannot be live-tested here and must be labeled unconfigured/unverified, not broken. No paid service was enabled. This does not establish anything about deployed credential settings.

The native library reader, property-sales reader, Census housing reader and agentic sweeps were not activated by the clean run's configuration. The native library reader requires location.systems entries; housing requires a Census geoid. The branch HTML pages instead went through the generic web reader. These configuration gaps are separate from endpoint failures.

All **61 relevant provider, connector-registry, linked-reporting and deployment tests passed**. These tests check code behavior, not live provider uptime. [Complete component/provider audit](wedgwood_remaining_providers_audit.csv), [fresh probe metadata](evidence/provider_audit/fresh_probes.json), and the existing [41-source outcome audit](wedgwood_source_health_audit.csv) preserve the distinctions. No implementation changes were made during this audit.
