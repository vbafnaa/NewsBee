# Search cache origin freshness

`search`, Exa `findSimilar` and Tavily `exploreSite` log every use separately in
`search_queries`. Numeric `created_at` is the use time;
`provider_fetched_at` is the original successful provider-fetch time. Cache hits
copy that origin unchanged, so intermediate uses never extend the seven-day
window. Results refresh at the seven-day boundary. No shorter story-search TTL
or freshness/recall tuning is introduced here.

Legacy direct successful rows (`cached: false`) may establish origin from their
original `created_at`. Legacy cached rows without a trustworthy origin are not
reused. There is no destructive log migration. Failures/refusals have no fetch
origin and never become successful cache entries. Deadline/admission blocks are
re-thrown rather than converted to apparently completed searches.

Request/provider keys, per-use run/location/topic attribution and isolated
source-map run scope remain in force. Exploration keys also include excluded
domains so differently constrained map requests cannot share results. Provider
accounting still happens only through the existing paid-call gateway on a miss;
cache hits do not reserve or issue provider calls.

Focused fake-clock regressions cover all three operations across intermediate
hits and the seven-day boundary, conservative legacy handling, failure/refusal,
execution blocks, isolated-run attribution and exploration request identity.
