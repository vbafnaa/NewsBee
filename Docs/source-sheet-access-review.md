# Spreadsheet source access review

Reviewed November 1, 2026 (Seattle local date). The [source spreadsheet](https://docs.google.com/spreadsheets/d/13V3WG3vsXFpn_pwgqW2h__b2d2v8dBsWAbT-xbFdHFk/edit?gid=2144765667) contains 125 source rows: 32 shared provider/platform/API entries and 93 community entries. Its community editions are Beacon Hill, Wedgwood / NE Seattle, Ballard and Moses Lake.

All 125 entries are included in the [per-source CSV](source-sheet-access-review.csv) and the [versioned inventory](../shared/source-sheet-inventory.json). Each entry records the original URL, community, decision, reason, evidence, check date and review expiry. The spreadsheet snapshot SHA-256 is `534f34485bc7d754136d4529ce8628f6794f8ca28c76e748c8cc3af03ad370a7`.

## Results

| Decision | Spreadsheet rows | Action |
| --- | ---: | --- |
| Approved API | 6 | Use the documented government API and factual fields with attribution and geographic filtering. |
| Approved feed | 2 | Use only the reviewed SPL calendar RSS and selected branch. |
| Permission required | 67 | Record the source and hold collection until suitable permission or terms are documented. |
| Integration required | 29 | Supply a supported endpoint, authorized account, parser, or coverage configuration before collection. |
| Blocked by terms or current crawler policy | 18 | Do not scrape the reviewed endpoint. Reasons distinguish terms, robots and page directives. |
| Unavailable | 3 | Access/TLS failed; no bypass attempted. |

These are collection decisions for the specified method and endpoint. They are not blanket legal clearance for a publisher's website or photographs. Robots permission alone does not authorize reuse; [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) distinguishes crawler rules from access authorization. An unavailable robots file or an AI-crawler disallow is held under Newsbee's existing policy. `noindex` holds also reflect the application's current policy, not a claim that indexing directives themselves are a copyright license.

## What is enabled

| Community | Source-map records from this import | Enabled | Held |
| --- | ---: | ---: | ---: |
| Beacon Hill | 43 | 5 | 38 |
| Wedgwood / NE Seattle | 25 | 2 | 23 |
| Ballard | 18 | 5 | 13 |
| Moses Lake | 14 | 2 | 12 |
| Total | 100 | 14 | 86 |

The eight approved spreadsheet rows produce 14 community/source configurations because NWS and USGS are shared by all four communities. Shared provider documentation stays in the catalog rather than becoming a news source; duplicate URLs share a source-map record. This explains why catalog and source-map counts differ. Existing unrelated sources are outside this import. Weather and earthquake collection also respects the existing `widerSources` setting; enablement does not guarantee a new item or publication.

The approved scope is:

- NWS alerts and USGS earthquake data for all four communities. Government-produced factual material is covered by the [NWS disclaimer](https://www.weather.gov/disclaimer) and [USGS copyright guidance](https://www.usgs.gov/faqs/are-usgs-reportspublications-copyrighted); third-party imagery and agency marks are excluded.
- Seattle SPD Crime Data, for Beacon Hill and Ballard, and King County food inspections, for Ballard. The [SPD dataset metadata](https://data.seattle.gov/api/views/tazs-3rd5.json) and [inspection dataset metadata](https://data.kingcounty.gov/api/views/r878-4sxa.json) identify the datasets as `PUBLIC_DOMAIN`. Existing field exclusions and locality filters apply. Police reports describe reported incidents, not convictions.
- Seattle Public Library events at Beacon Hill and Ballard branches through `https://www.trumba.com/calendars/kalendaro.rss`. SPL explicitly offers calendar subscriptions in its [calendar instructions](https://www.spl.org/using-the-library/using-this-website/using-our-online-calendar); its [website terms](https://www.spl.org/about-us/policies/online-privacy-and-terms-of-use) and the feed endpoint were reviewed. This approves selected-branch event facts, not copied images or an unrestricted crawl of event pages.
- DOJ releases for Beacon Hill through the existing DOJ API, subject to neighborhood relevance. The [DOJ information policy](https://www.justice.gov/legalpolicies) and [developer documentation](https://www.justice.gov/developer) support official-text collection; third-party photos and seals are excluded. The connector queries DOJ's API rather than scraping the district newsroom HTML.

## Holds that need attention

- Wedgwood's Northeast Library row has a supported RSS route, but the onboarded neighborhood has no selected library system. Confirm coverage and select the branch explicitly before enabling; there is no citywide fallback.
- Ballard's “Crisis Contact” row points to the same SPD arrest dataset as other rows. It is retained in the catalog but is not treated as a separate crisis dataset. Arrest-specific reporting needs field interpretation before collection, despite the dataset's public-domain label.
- Stacker and PR Newswire website scraping is held under their published [Stacker terms](https://stacker.com/terms-and-conditions) and [PR Newswire terms](https://www.prnewswire.com/terms-of-use/). Licensed syndication or a specifically authorized feed is a separate path.
- Several PTA, athletics and city calendar endpoints disallow an AI crawler under Newsbee's existing robots checks. Social platforms excluded by current policy remain excluded. No login, CAPTCHA or paywall was bypassed.
- El Centro's reviewed page and WIAA's feed carry `noindex`, which the current application treats as a collection hold. Beacon Food Forest, Beacon Arts, Beacon Business Alliance and other accessible sites remain pending where suitable automated access/reuse permission was not established.
- King County GIS specifies a 60-second crawl delay, beyond the current collector's 30-second limit. Moses Lake's two PDFs need a PDF reader and confirmed reuse scope; exceeding the audit's 2 MiB limit is an integration issue, not a robots prohibition.
- Obituaries and vital-record rows remain permission-first. No publisher/family authorization was supplied, and no photo reuse was approved.

## Import and enforcement

The four local workspace IDs are `osm-n150975261-wa` (Beacon Hill), `osm-r13915552-wa` (Wedgwood), `osm-w1551637823-wa` (Ballard) and `moses-lake-wa` (Moses Lake). The importer does not run discovery, collect stories, call a model or publish an edition.

An administrator can preview the versioned inventory with `POST /api/admin/source-sheet` and JSON `{"apply":false}`, then apply it with `{"apply":true}`. The route uses the normal admin and same-origin checks. `GET /api/admin/source-sheet?location=<id>` supplies the source-review table inside each location's source network.

Pending community sources are paused and cannot be activated through the ordinary source controls while their review denies collection. Discovery preserves the review; execution rechecks it even for an already-queued task. Approved feed requests are limited to that exact feed and its robots file. Reviews expire December 1, 2026 and stop collection until renewed. Reimport preserves an editor's pause/reject decision and does not duplicate records.

All imported sources have publisher photos disabled. Collected facts prevent later
publisher-image discovery or article-page crawling by locality/authoring steps. The
separate [image pipeline](image-pipeline.md) may obtain an independently licensed photo
of an event's actual venue from Commons, without crawling the publisher's site. It
supplies no context photos for records. Use [photo-sourcing-research.md](photo-sourcing-research.md)
for relevant people-photo candidates and the permissions still needed. Stock photos
are not required to complete source onboarding.

Historical community covers were removed from the reader on November 2, 2026. Records
receive no context photos. Separately reviewed, recent [event venue photos](event-venue-photos.md)
may appear only beside matching events, with their capture date, credit and license.
Publisher scraping and source-photo restrictions remain unchanged.

## Rechecking and validation

From `apps/journalist-site`, `node node_modules/vite-node/vite-node.mjs scripts/audit-source-sheet.ts` gathers bounded endpoint/robots/linked-terms evidence into ignored `.local/source-research/source-access-audit/`. It does not approve sources or change the versioned inventory. The input is the saved public CSV export at `.local/source-research/photo-audit-sheet.csv`; refresh that export before a new review. Raw responses are research material and are not shipped to readers.

After updating reviewed decisions in the inventory, regenerate the CSV with `node scripts/source-sheet-report.mjs`. Tests cover import completeness and idempotence, holds surviving discovery and queued tasks, review expiry, feed scope, branch filtering, hidden private connector parameters, and photo suppression. Existing internal-access and authoring tests are also run.
