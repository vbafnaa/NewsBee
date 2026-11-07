# OpenStreetMap discovery repair

The live OSM discovery method now succeeds for Wedgwood through a working public fallback. This is a local code change, not a deployment.

## Evidence

A standalone discovery invocation for `osm-r13915552-wa` returned `ok: true`, **52 map elements**, **9 qualifying source candidates**, and **7 newly added source records**. This method invocation is separate from the earlier full pipeline runs. It used no registry input. [Raw method result](evidence/osm_repair/live_method_result.json), [source list](wedgwood_osm_sources.csv), [source-map snapshot](evidence/osm_repair/source_map.json).

The main `overpass-api.de` and `overpass.private.coffee` endpoints still timed out in this invocation. `maps.mail.ru/osm/tools/overpass/api/interpreter` returned the successful response. The code repairs failover; it does not repair those remote servers or guarantee future uptime. Two sequential timeouts still make this invocation slower than a healthy first endpoint.

## Changes

- Query the saved neighborhood bounding box, then apply the existing exact area/type filters locally. Previously bbox-based neighborhoods were queried with a fallback 3-km radius and multiple overlapping queries. Remove the pre-filter output truncation; the existing 40-source cap and response-size limit remain.
- Align the server query budget (20 seconds) with a longer client request deadline (30 seconds).
- Remove `kumi.systems` as a separate mirror of `private.coffee`; add a distinct documented global-data provider. The [OpenStreetMap public-instance directory](https://wiki.openstreetmap.org/wiki/Overpass_API) identifies the renamed service and alternative endpoint.
- Share bounded failover between OSM source discovery and institution enumeration. Retain every endpoint's error, reject HTTP-200 error remarks/incomplete response shapes, and honor refusal cooldowns for HTTP 406/429.
- Keep HTTPS GET, identifying Newsbee headers, response-size limits and existing external-service controls. Diagnostic POST attempts timed out; the bounded GET succeeded. No access restriction was bypassed.

The separate landmark lookup inside the locality module still has its existing request path; this change targets source discovery/institution enumeration.

## Actual added candidates

- Birds Connect Seattle — https://birdsconnectseattle.com
- Our Lady of the Lake Church — https://parish.ollseattle.org/
- Seattle Off Book Productions — https://seattleoffbook.com
- Our Lady of the Lake School — https://school.ollseattle.org/
- University Preparatory School — https://www.universityprep.org/
- Wedgwood Elementary School — https://wedgwoodelementary.org/
- Wedgwood Swim Club — https://www.wwpool.org/

These are OSM-listed website candidates. Some map URLs can be outdated (for example, the map's Wedgwood Elementary URL differs from the official directory's URL). This test does not establish that those sites currently yield useful news. Collection was not rerun, and nothing was authored or published.

## Validation

All **22 discovery tests** pass, including new tests for error-response failover, refusal cooldown, endpoint deduplication, response validation, timeout ordering, bbox use and geographic/type filtering. TypeScript checking and `git diff --check` pass. [Implementation hashes](evidence/osm_repair/implementation.json).
