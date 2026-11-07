# Wedgwood reader repairs

Implemented locally on November 6, 2026 (America/Los_Angeles). No deployment or publication.

## Changes

- **GDELT:** malformed/non-JSON responses and failed requests no longer become successful empty searches. Valid `articles: []` remains a legitimate empty result. Mixed success/failure is partial. HTTP 429 propagates to the job queue, respects Retry-After (minimum 60 seconds), and sets a shared Mongo host cooldown plus process fallback. The queue uses its bounded rate-limit retries instead of immediate ordinary retries. No provider bypass or additional paid service was introduced.
- **Community reporting:** use advertised RSS feeds from active/pinned community websites in the existing independent source map, bounded to three hosts. This run discovered the council feed without consulting the human registry. Keep each failed URL and cause, preserve partial status, and record articles rejected by the reporting checks. Support explicit WordPress publication timestamps when OpenGraph dates are absent, using the hostname as publisher attribution when necessary. Robots, public-address checks, dates and locality remain enforced.
- **School calendars:** recognize `/events/ics/` exports and read explicit calendars before feed guesses. Accept dated school events without a LOCATION field in the generic website reader; leave the venue empty. The dedicated library iCalendar parser still requires venue information by default.
- **Library calendars:** recognize embedded Trumba configurations and preserve `filterview=LocationNET`. Parse event dates rather than treating the RSS as publication-dated news. For a branch-specific source, require the event's venue URL to match that branch. Keep locality pending.

## Live connector checks

These are direct executions of the production connector functions against public endpoints using the archived independent source map, **not a new full orchestrated pipeline run or production test**. No registry input, model locality pass, ranking, article authoring, database writes or publication occurred. The reporting date was fixed at November 6, 2026; the default website lookahead was 14 days. Every returned calendar record still needs locality verification.

Two checks are saved separately; their results must not be added together:

- [Initial check, 02:41:09 UTC](evidence/reader_repairs/2026-11-07T02-41-09-803Z/results.json)
- [Final check, 02:43:03 UTC](evidence/reader_repairs/2026-11-07T02-43-03-636Z/results.json)

| Component | Final live outcome |
|---|---|
| Wedgwood Elementary calendar | 3 event records: enrollment information session November 19; Veterans Day closure November 11 from school and district feeds. These represent **2 distinct happenings**, with a duplicate closure across feeds. |
| Northeast Branch events | 3 events: Family Story Time November 10 and 17, Genealogy Drop-In November 12. Explicit dates and Northeast Branch venues retained. |
| Community reporting | Discovered `https://www.wedgwoodcc.org/feed/` automatically and retrieved 3 linked council articles. **0 verified reports** after recency/location checks. Mobilize's linked page was blocked because robots.txt could not be read; the exact failure is retained. |
| GDELT | Both checks returned HTTP 429 with a 60-second retry delay, correctly surfaced as a refusal rather than an empty success. Provider availability is not repaired by client code. |

The recent Dahl Field article lacks an explicit Wedgwood mention in its substantive paragraphs; its publication date can now be parsed, but it does not pass the current reporting locality rule. Two October 29 council articles are older than the seven-day reporting window. Their RSS timestamps are later than the article timestamps; the verified article publication time remains authoritative. Do not count these rejected articles as discovered useful neighborhood stories.

**Separate counts:** 2 calendar source endpoints successfully extracted; 1 community feed independently located; 6 calendar records (5 distinct happenings after identifying the duplicate closure); 3 council article retrievals; 0 accepted community reports. This audit does not recompute human-source recall or combine earlier run totals.

## Validation

- 57 regression tests passed across reader repairs, community reporting, connector registry and service deployment contracts.
- TypeScript `tsc --noEmit` passed.
- Tests exercise failed versus genuinely empty GDELT responses, partial searches, 429 cooldown, durable Retry-After scheduling, missing school venue, branch-filter preservation, cross-branch rejection, community fallback, individual linked-URL failures, and WordPress publication dates.
- The opt-in live audit test writes evidence; its passing means the audit completed, **not that every provider worked**.
- Reproduce from `apps/journalist-site`: `NEWSBEE_READER_LIVE=1 npm test -- pipeline/tests/connectors/reader-repairs-live.test.ts`. It makes public network requests and creates a new timestamped evidence folder.

## Remaining limitations

GDELT may continue rate-limiting this network. Blocked or unavailable article hosts cannot be made accessible by parser changes. Community locality still needs a separately validated way to recognize nearby named facilities such as Dahl Field; this change does not loosen that rule. Cross-feed duplicate closure records remain for downstream deduplication. Production networking, shared database concurrency and a complete deployed run have not been verified by this connector-level audit.

## PR integration validation

Merged `origin/main` at `bd8a379` before opening the PR. Preserved its school/group discovery methods, checked-section-page limits, and shared playbook. The earlier general-query priorities and 60-suggestion limit now live in that playbook; its generated artifacts and expected snapshots were updated. The older live evidence above remains a pre-merge connector audit, not a live test of the combined branch.

Post-merge validation: 150 discovery, reader, community, registry, deployment-contract and playbook tests passed, plus 6 playbook snapshot tests; TypeScript checks passed. The database-backed category tests required a local-port-enabled test environment. Snapshot differences were reviewed: extra priority queries, bounded/encoded Overpass requests, diagnostic wording, and model suggestions retaining item-level locality checks.
