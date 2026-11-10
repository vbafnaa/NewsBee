# Community cover photographs

**Retired from the reader on November 2, 2026.** The historical allowlist below is kept
as review evidence, but these covers are no longer displayed. The current policy uses
actual story photos or recent, explicitly labeled event-venue photos; records receive
no context image. See [event-venue-photos.md](event-venue-photos.md).

Four real photographs were checked against their Wikimedia Commons file metadata and
description pages on November 1, 2026, downloaded for visual inspection, and verified
through the local reader image endpoint. Their licenses permit reuse with attribution;
the two share-alike versions also apply to adaptations of their respective photos.

| Community | Photograph and date | Photographer | Reuse license |
| --- | --- | --- | --- |
| Beacon Hill | [Beacon Food Forest ground-making](https://commons.wikimedia.org/wiki/File:Beacon_Food_Forest_ground-making_(8050522883).jpg), September 29, 2012 | K. Shuyler | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| Ballard | [Ballard Farmers' Market 01](https://commons.wikimedia.org/wiki/File:Ballard_Farmers%27_Market_01.jpg), July 29, 2007 | Joe Mabel | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| Wedgwood / NE Seattle | [Wedgwood Rock 01](https://commons.wikimedia.org/wiki/File:Wedgwood_Rock_01.jpg), July 28, 2007 | Joe Mabel | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| Moses Lake | [Moses Lake downtown](https://commons.wikimedia.org/wiki/File:Moses_Lake_downtown.jpg), October 20, 2019 | ECTran71 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |

The Beacon Hill and Ballard photos show real community gatherings. The Wedgwood and
Moses Lake files show local landmarks/streets. None are AI-generated or generic stock.

The reader labels each image **Community file photo**, states the original date and
subject, links the photographer credit to the original file page, links the license, and
discloses cropping for layout. These covers appear with the community edition rather
than beside a specific police, health, housing or school report. They do not establish
who attended a current event or what a current incident looked like.

`shared/community-photos.json` is the reviewed allowlist, keyed to the four exact local
workspace IDs. `shared/community-photos.ts` validates it, and the reader route
`/reader/api/community-images/<location_id>` only fetches these records through the
existing DNS-checked, size-limited raster delivery service. Unknown communities return
404; upstream failures hide the cover without blocking the edition. Adding a query URL
cannot turn this endpoint into an arbitrary proxy.

This approval is independent of the [source-sheet review](source-sheet-access-review.md).
Publisher/organizer website scraping and their other photographs remain held where
permission has not been established. The reviewed source collection rules are unchanged.

Validation includes route and allowlist tests, HTTP 200/image/jpeg checks for all four
files, and a real-browser desktop/mobile check of the caption, date, attribution and
license link. Research evidence and screenshots are in ignored
`.local/source-research/community-photos/` and `community-cover-*.png`.
