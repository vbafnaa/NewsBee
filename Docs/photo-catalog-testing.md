# Photo catalog: permissions and testing

This work adds photo supply for Wedgwood and Moses Lake. It does not change the reader's
fonts, publish editions, enable a paid service, or clear a source's scraping restrictions.

The primary path is: approved article candidates → scoped community catalog → actual
venue or permit street search → decode and size checks → visual review → crop critic →
archive → attach → publication checks. Stock remains a separate final pass for eligible
neutral activities. Current mode omits visual inference; new catalog candidates still
require a complete decode and usable card crops. Use Agentic mode for pixel review.

## Obtain and record permission

Start with [Downtown Moses Lake Association](https://www.downtownmoseslake.org/team-4)
(`events@downtownmoseslake.org` or `director@downtownmoseslake.org`) and
[Columbia Basin Allied Arts](https://www.cba-arts.org/contact/)
(`events@cba-arts.org`; director: `director@cba-arts.org`). The
[research report](image-supply-wedgwood-moses-lake.md) lists the Wedgwood contacts and
other specific photo opportunities. No outreach has been sent.

Ask the photographer or an organization authorized to grant rights for specific files:

> May Newsbee use your photographs of [event/venue] at no charge in our community newsletter and
> website, retain them in archived editions, and resize/crop them for desktop and mobile?
> Please supply the original files, capture dates, places, factual captions and exact
> photographer credits. Please confirm which files you own or can authorize, any
> applicable subject permissions, restrictions, expiry, permitted repeat use, and a
> contact for corrections or withdrawal.

Keep the reply or agreement in access-controlled storage. Record its HTTPS reference as
the catalog source's `evidence_url`; that field is admin-only and is not attached to the
public image. Use `image_license: "Used with permission"` when relying on a private grant.
Leave `image_license_url` absent unless there is a public rights statement to link.
Never put a private email thread or signed access token in a public image metadata field.

Set `permission.editorial`, `permission.archive` and `permission.crop` only when the
grant covers those uses. Add the covered image metadata, constrain the event/venue/street
scope, set a review/expiry window, and change `status` from `pending` to `active`.
The importer rejects active supplied sources with missing grants, empty photo lists,
unknown capture dates, incomplete credits, unsafe URLs or insufficient dimensions.
File hosting must also permit Newsbee's guarded download; permission to publish alone
does not authorize scraping an entire site. Organizer-supplied files avoid that crawl.

Commons sources use each file's public license. A category is a discovery aid: every file
still needs an approved license URL, creator, known recent capture date and exact identity
match. [Creative Commons describes these advance grants](https://creativecommons.org/cc-licenses/);
attribution and applicable adaptation/share-alike requirements still apply. Public
visibility, robots permission, a press-page label or an API response alone is not a grant.

## Run the checks

Run these from `apps/journalist-site` in the integration worktree:

```powershell
npm.cmd run photos:test
npm.cmd run lint
```

Tests use disposable MongoDB databases and mock model/HTTP responses. They do not read
the private vision environment file, call hosted models, or change published editions.
The first MongoDB test run may need to download the test server executable.

Validate the two supplied manifests without a database or network request:

```powershell
npm.cmd run photos:catalog -- --manifest ../../Docs/examples/photo-catalog-wedgwood.json
npm.cmd run photos:catalog -- --manifest ../../Docs/examples/photo-catalog-moses-lake.json
```

Both should report `valid: true` and `applied: false`. The Moses Lake organizer sources
are intentionally `pending`, with false grants and empty photo arrays.

Inspect live Commons metadata in a disposable database, optionally decoding up to three
downloads. This does not run a vision model or approve images for a story:

```powershell
npm.cmd run photos:inspect -- --manifest ../../Docs/examples/photo-catalog-wedgwood.json --download 2
npm.cmd run photos:inspect -- --manifest ../../Docs/examples/photo-catalog-moses-lake.json --download 0
```

Reports and downloaded inspection copies go to ignored `.local/source-research/` in this
worktree. `runtime_visual_approval` and `published_data_changed` remain false. A successful
decode is a technical check, not a judgment that the image enriches a particular story.

On November 3, 2026, inspection returned 24 Wedgwood category candidates; 20 passed
metadata review. Two actual downloads decoded at 3840×5760 and 3840×2560 and passed the
card crop checks. Moses Lake returned zero candidates and zero downloads while pending.
These counts can change when files or metadata change.

Validation for this change: 215 focused regression tests passed across the targeted
runs, along with journalist TypeScript checking, the reader's 50-file Astro check,
and both production builds. The local edition previews also confirmed that Wedgwood's
two record stories and Moses Lake's census story retain their text-only decisions.

## Test with the local app

Import only a reviewed manifest when ready to alter local catalog configuration:

```powershell
npm.cmd run photos:catalog -- --manifest ../../Docs/examples/photo-catalog-wedgwood.json --local --apply
```

This command writes only to `mongodb://127.0.0.1:27027`, database `newsbee`, and verifies
the community is onboarded. It does not publish anything. Without `--apply`, it only
validates. Without `--local`, an apply request fails.

To inspect the latest local edition in a disposable database:

```powershell
npm.cmd run photos:preview -- --local --location osm-r13915552-wa
npm.cmd run photos:preview -- --local --location moses-lake-wa
```

This edition preview uses Current mode and reads the existing local data. It does not
visually approve photos or update editions. For an end-to-end visual test, choose
**Photos: Agentic** in the local run panel, use the configured free Ollama vision model,
leave paid services off and retain the 40-call edition cap. Inspect the photo decisions
and both delivered crops before using the normal publication control.

The existing Wedgwood dispatch/court stories and Moses Lake census story must remain
without context photos. A past car-show image cannot illustrate next year's show or an
unrelated safety story. Test a matching, verified event to exercise event-photo selection.

The initial preview used smaller local editions: 2 Wedgwood items and 1 Moses Lake item.
The subsequent November 3 refresh imported the complete deployed snapshots and evaluated
all 76 and 3 items. An edition-wide uniqueness correction then removed eight repeated
placements of one venue photograph. The remaining mime-class placement was then withheld
because its description names Georgetown Studios while its venue field names Pike Place.
Both local editions currently render text-only. The imported
copies retain their published text and IDs but do not reconstruct upstream source or
authoring approvals. Public image URLs alone do not establish reuse rights. See the
[edition comparison](image-pipeline-state.md#edition-data-mismatch).

## Catalog contract

The examples use manifest version 1 and one exact `location_id`. An import contains up
to 20 sources; a community holds at most 100. Sources use stable IDs and revision hashes.
Re-import replaces matching IDs; it does not remove omitted sources. Revoke a source
explicitly with `status: "revoked"` and apply that manifest.

Supported source kinds:

| Kind | Discovery | Bound |
| --- | --- | --- |
| `commons_category` | Files directly in one reviewed category; no subcategory crawl | Two pages of 12 files |
| `commons_files` | Explicit file titles | 12 files |
| `supplied` | Rights-holder-provided image URLs and metadata | 24 photos; all three grants required when active |

Event scopes require an exact title/alias, city and event date. Optional `source_urls`
further constrain the original story URL. Commons event files must identify that event
and city and have its exact capture date. Venue and street scopes require the actual
named place in the correct city. Two matching sources are considered per story.

Metadata discovery is cached for one day. Every story still rechecks scope, permissions
and photo age. Catalog revisions invalidate earlier image decisions. All photos require
known capture dates within 365 days; upload/publication dates do not substitute. Agentic
review keeps its four model-call and six-download story limits, full decoding, no
upscaling, and 1200-pixel card / 1800-pixel lead crop requirements.

The administrator API is `GET/POST /api/admin/locations/{locationId}/photo-catalog`.
It uses the existing admin session and same-origin guards. The internal maps password
does not grant access. POST is a dry run unless `?apply=true`; bodies are capped at
256 KiB. The API is suitable for authenticated tooling; no public upload form is added.

Publication rechecks the catalog revision and scope. Reader delivery rechecks the active
grant, community, revision and capture age even for archived files and conditional
requests. These responses use `Cache-Control: no-store` so revoked grants are not served
from the reader's HTTP cache. Removing a community removes its catalog and metadata cache.

The research CSV/JSON remains evidence, not an automatic permission import. Pending city,
school, organizer and performer sources remain held. No Openverse, Flickr, Pexels or
Unsplash provider has been enabled by this change.
