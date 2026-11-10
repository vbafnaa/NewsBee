# Image pipeline

**Current default: AI editorial illustrations.** See [the illustration pipeline](illustration-pipeline.md)
for the original watercolor collection, Wedgwood/Moses Lake identity, selection rules and preview links.
The documentation below describes the optional documentary-photo workflow.

See [the current-state diagram and publication results](image-pipeline-state.md) for
the latest local snapshot and the boundary between local work and the deployed site.

Newsbee runs a separate, resumable `image_story` job for every validated story, after
authoring and before the existing publication checkpoint. The existing local worker and
serverless job chain execute it. Missing photos do not hold validated news text.

The visual editor is implemented in [image-pipeline-agentic.md](image-pipeline-agentic.md).
The scoped community catalog and safe inspection commands are documented in
[Photo catalog: permissions and testing](photo-catalog-testing.md).
New runs default to **AI illustrations**. Choose **Agentic photos** for the workflow below;
older runs retain their saved run options. **Compare** runs the agent in shadow without replacing rule-selected images.
**Current** uses the existing source/metadata checks without a vision model. These photo
modes are independent of the discovery flow. No paid service is enabled automatically.

Agentic mode sends actual decoded image pixels to a capable configured model, compares
candidates, and separately critiques desktop/mobile crops. It requires at least 1,200
usable pixels across for cards and 1,800 for leads, without upscaling. Original files and
responsive derivatives are stored in MongoDB. No image is attached when visual review
is unavailable or its evidence/quality/budget checks fail. Existing published editions
are not automatically rewritten by enabling this feature.

The stages are **classify → visual brief → check source rights → discover article/catalog/venue/street photos → decode → visual review → refine → crop critic → archive → attach → publish**.
Stock remains a separate secondary job after the primary pass settles.
Each decision is stored in `story_image_results` under a versioned edition/story key.
An original photo may appear only once per edition. Candidate selection skips photos
already assigned to another story, using source identity and downloaded-byte hashes.
Atomic reservations prevent concurrent story jobs from choosing the same photo.
Publication and reader normalization also remove repeated placements, including alternate
crops of the same archived original, while retaining every story. If no distinct approved
candidate remains, the story stays text-only.
Every candidate also passes the shared story/role/place check before download and again
before attachment. Publication binds the selected photo metadata to the current story;
changed captions, roles, places or story copy require a new decision. Reader normalization
and image delivery withhold conflicting location tags in older payloads as well.
In agentic mode, both visual review and the crop critic must separately confirm subject,
place, timing and consistency of the evidence. A high quality score cannot override a
failed relationship check. `photo_editor_v4` supersedes earlier model approvals.
The portal's story table shows the photo outcome; the item trace shows stages,
photographer, source, capture date, license and candidate rejection reasons.

## Photo supply and subject discovery

Article discovery reads structured images, social metadata and the main article's images,
including lazy loading, `srcset` and `picture` sources. It inspects at most 60 article
image elements, retains the best 20 metadata candidates, and passes the best four onward.
Ranking uses subject words, explicit credits and declared dimensions. It filters obvious
graphics and navigation images and merges known resize variants. Declared sizes are
only discovery hints: native pixels and visual quality are still checked after download.
Capture dates and photographer identities are never inferred from a page's publication
date or author. Existing collected candidates remain usable without another page fetch;
fresh collection uses this extractor, and the independent image cache now uses `images_v4`.

The scoped photo catalog also accepts `person`, `organization` and exact-URL `story`
coverage. Subject scopes require an identity evidence URL and specific approved article
URLs or exact publisher domains. Full subject names must match the original story title;
Commons subject searches also require the named subject and city in file metadata.
There is one bounded Commons query per reviewed subject source, with a daily cache.
Portraits are eligible only for explicit subject sources; ordinary context searches still
exclude them. `image_subject` travels with the photo, so publication and reader delivery
can withhold it when the story no longer supports that subject. These scopes do not add
generic photographs to police, census, court, housing-market or obituary records.

**Review inputs → Photo supply** provides an administrator workbench for each location.
It groups the 13 researched Wedgwood publisher candidates and lists recurring organizer
leads for Wedgwood and Moses Lake. A lead does not approve a file. Administrators create
an invitation with a coverage scope and grant expiry of at most 90 days. The interface
prepares an unsent request; it does not contact the recipient. See
[photo-permission-requests.md](photo-permission-requests.md) for the concrete requests.

The invitation's `/photo-supply/[token]` form needs no journalist account. A supplier
confirms authority and no-charge editorial, archive and crop permissions, and supplies
original public HTTPS file URLs, source pages, credits, captions and recent capture dates.
The server accepts at most six photos per batch and five batches per invitation. Links
expire after at most 14 days; only their hashes are stored. Public responses exclude
contact information and internal evidence. Writes require the invitation's same origin,
and JSON bodies are bounded to 64 KiB. Invitation pages are excluded from indexing.

Submissions remain pending until an administrator approves them. The catalog grant is
bound to the exact files, scope, rights and expiry by a fingerprint in the private consent
record. Approving a grant does not approve image quality or publish an edition. Missing
dimensions are measured during the normal full decode; minimum native resolution, visual
review, crop review and edition-wide duplicate prevention still apply. Revoking a photo
grant withholds archived delivery, including conditional requests. Revoking an invitation
only stops new submissions. Location cleanup removes invitation and submission records.

Run `npm run photos:test` in `apps/journalist-site` for the regression suite, `npm run lint`
there for TypeScript, and `npm run check` in `apps/reader-site`. For manual testing, create
an invitation from Review inputs, open it in a separate browser, submit a dated original
with consent, and confirm it appears as pending. Approve the grant and run image sourcing
for a matching story in a test edition. Withdrawing the grant must block delivery of any
published catalog photograph. Permission approval alone never republishes an edition.

## Compatibility with run options

The image integration is rebased onto `origin/main` at `eacb76e` (PR #106), retaining
worker slots, separate source-map runs, source deadlines and shared fetch state. It
also retains the one-click / agentic pipeline (`0535884`), exploration/relaxed
publication (`02206c6`) and search-provider/community-scoping work (`7777322`). Both current and agentic
flows share image jobs after authoring. Autopilot queues publication after primary and
stock work settles; manual runs keep publication review. Run story limits, topic filters,
primary-source tiers, digest entries and the history toggle remain in the common path.
Image and stock jobs remain serial within each edition and are visible to the shared
worker dispatcher. Source-map runs finish separately without entering image authoring.

Commons metadata calls and photo validation are logged in `api_calls` as free work;
image outcomes also appear in `run_decisions` with their story id and policy. The
kick-off panel's free-service list includes **Wikimedia Commons photos**. Switching it
off suppresses primary context and secondary stock requests without suppressing the
story. No paid service is enabled by image sourcing. Reader photo approval and withdrawal
remain authoritative, and publisher URLs still require a current rights audit. Saved
credit/caption fields survive publication even when an unaudited image URL is withheld.

The kick-off panel exposes photo mode and an edition-wide photo model call limit (40 by
default). A story shares four call reservations and six downloads across primary and stock
work. Hosted model calls time out after 25 seconds; a story's photo work has a 180-second
deadline. Local Ollama uses 240 seconds per request and 600 seconds per story to support
CPU inference without API fees; see the local setup in [image-pipeline-agentic.md](image-pipeline-agentic.md).
Failed attempts consume reservations. Hosted provider attempts additionally pass the
existing `agent_model` budget gate and usage logger. Exact prompt/pixel/model/policy
matches can reuse a seven-day review cache; permissions and freshness are still rechecked.

| Outcome | Meaning |
| --- | --- |
| `selected` | An approved source photo or recent licensed photo of the actual event venue or permit street passed validation. |
| `not_applicable` | Record-based story: no context photo and no image-search request. |
| `no_image` | No suitable recent venue photo was found. Render text-only. |
| `permission_required` | Actual publisher-photo reuse has not been approved. Render text-only. |
| `failed` | Image work exhausted three retries. Preserve the story and expose the failure for optional retry. |

Photo mode does not display historical community covers or decorative illustration
placeholders. Illustrated mode uses the separate reviewed artwork collection. Census, police, dispatch, court and housing-market records do not receive
context photographs. Development/building-permit stories may use a photograph of their
actual named street in the correct city. A broad neighborhood view is not enough.
An actual approved story photo can still
be used when the source supplies one.

For events and meeting previews only, a photograph of the actual venue can fill a
missing source photo. First the job checks the reviewed `shared/event-venue-photos.json`
allowlist. Otherwise it queries the official Wikimedia Commons API for up to twelve
candidates per query, with at most two place-name variants (for example Branch/Library).
Address/room suffixes are removed before venue matching. Both the venue name and the city must explicitly match; vague, unknown,
online or ambiguous venues get no location-photo substitute in the primary pass. Only supported CC BY, CC BY-SA
and CC0 licenses with matching license URLs are accepted. Restricted media, portraits,
logos, drawings and unsuitable subjects are excluded. A known capture date within
365 days is required; recent upload timestamps cannot make an old photo eligible.
Current mode downloads at most two acceptable candidates for validation. Agentic mode
compares up to three per round, within its shared six-download cap. Search results have
a one-day cache and a MongoDB TTL index. This is a separately licensed venue asset,
not approval to scrape the organizer's pages or copy its photos.

The one-entry reader allowlist fallback also supports the already-published editions
without modifying their text. New editions persist selected venue assets in their
published JSON through the normal image jobs and publication path.
Visible credits use **Photo: Joe Mabel, Carkeek Park**. An accessible photo-details
control contains the license link, capture date, original photo page and the context/crop
disclosure. Stock's visible line is simply **Stock Photo**; its author and rights remain
in photo details. Credit formatting is shared by the client and server-rendered readers.
See [event-venue-photos.md](event-venue-photos.md).

Permit street photos carry `image_role: "area"` and `image_place`. They must match all
street tokens, including the ordinal and direction, plus the city. Photos of another
street, real-estate interiors, old captures and unknown dates are rejected. A permit
never receives construction stock, and an area photo never claims to show the permitted
work or its progress. Source images still take priority.

## Last-resort stock stage

Only after every primary image job has completed or exhausted its three retries does
the queue create separate `stock_story` jobs for eligible stories still without photos.
A selected source or venue photo always wins. Stock has its own three retry attempts,
and publication waits for this secondary pass to settle. Missing stock stays text-only.

The initial stock topics are board/tabletop games (including chess), gardening/seed-swap
activities, and craft/knitting/crochet/pottery workshops. Selection requires an explicit
activity match in the event's title or description and the candidate's metadata. It is
limited to events; records, profiles, allegations, injuries, memorials and religious or
medical contexts receive no stock substitution. Expanding the topic list is an explicit
editorial/code change, not an unrestricted keyword search.

The provider is Commons' official API, using the same accepted licenses, known capture
date within 365 days, attribution, download limits and actual raster-dimension checks.
There is no paid stock subscription or separate stock API key. Current mode makes no
model calls; agentic stock uses the same visual review and critic as primary photos. Negative searches
are cached for a day. Published stock carries `image_role: "stock"`; the reader labels
it **Stock Photo**, with credit/license, date and the event/venue/participant disclosure
available in photo details. The audit preserves the
primary no-photo outcome and the secondary candidate decisions.

## From source to reader

1. Collection looks for article schema.org images, Open Graph/Twitter metadata and
   feed media/enclosures. Relative links resolve against the source page. Credits,
   publisher-provided alt text, dimensions and the original page travel with the image.
2. After authoring, the image job checks current affirmative source-map approval for
   both collection and image reuse before inspecting a publisher image. Existing crawler,
   feed-only and paywall restrictions still apply. Source photos are cached separately
   from text/model output; changed source URLs invalidate the source-image cache.
3. Image validation shares the reader's public-DNS/redirect guard, timeout, byte limit
   and raster-signature checks. It also checks actual JPEG/PNG/GIF/WebP header dimensions
   (baseline minimum 240×120). Agentic mode additionally fully decodes and orients the file,
   enforces the higher editorial resolution and reviews both crops. Unknown dimensions are rejected. The edition entry keeps photo
   metadata alongside its saved decision. Retried attachment repairs use the same audit;
   a changed venue or rewrite revision invalidates it. Reassembly clears image jobs/audits.
4. Publication rechecks current publisher approval and venue-photo freshness before
   including `image`, `image_credit`, `image_source_url`, `image_alt`, dimensions and,
   for contextual images, `image_role`, `image_place`, `image_caption`, `image_date` and license fields.
5. The reader requests `/reader/api/images/<location>?edition=<id>&item=<index>`.
   The index refers to the original published items array, before display sorting.
   The endpoint resolves an image only from an edition of a listed community; it never
   accepts a user-supplied image URL.
6. Delivery validates public HTTPS destinations, pins connections to checked DNS
   addresses and validates redirect destinations. It allows JPEG, PNG, WebP, GIF and
   AVIF with matching raster signatures, with an eight-second download deadline, three redirects
   and a six-MiB body limit. SVG and HTML responses are rejected.
7. Successful responses have ETags and one-hour browser/CDN caching with one-day stale
   reuse. Each server instance also has a bounded 24-MiB image cache and coalesces
   simultaneous requests for the same URL. The instance cache can reuse a recent
   successful image when its origin fails.
   Up to eight origin downloads run at once; a bounded queue handles larger photo grids
   with a sixteen-second total wait/download deadline. Metadata page requests use the
   same public-DNS and pinned-connection guard, including robots and redirect requests.

## Presentation and failure behavior

The lead photograph loads eagerly; other photographs load lazily. Source credits link
to the original page, and publisher-provided alt text is preserved. Missing photos render
no media frame. Blocked, too-small or broken photos remove their frame entirely; a lead
without a photograph uses the full text column. Image failures do not interrupt reading,
citations, sharing or reporting.

Legacy URL-only editions use an origin-backed cache. Agent-approved editions additionally
carry an `image_asset_id` and serve archived, reviewed WebP variants from MongoDB, so an
origin outage does not remove those photos. Reader-submitted assets remain subject to
current approval and no-store delivery. No separate storage account is required; the
existing reader/pipeline MongoDB connection is used. Hosted vision requires an enabled
Agent model service and a configured image-capable model. Older editions are not
automatically republished by this implementation.

## Verification

From `apps/journalist-site`, a live preview can copy a local published draft into a
disposable isolated database and exercise real photo acquisition without changing or
republishing the edition:

```powershell
node node_modules/vite-node/vite-node.mjs scripts/preview-image-pipeline.ts --local --location osm-w1551637823-wa
```

The preview report is saved under `.local/source-research/image-pipeline-preview-<location>.json`.
The November 2 Ballard preview processed thirteen validated stories. The primary pass
returned one approved venue photo, seven record exclusions, two events without a recent
licensed venue match and three publisher-photo permission holds. The secondary pass
selected an October 9, 2026 [chess photograph](https://commons.wikimedia.org/wiki/File:CHESS_GAME_Maddox_vs_Kai.jpg)
by Bennett Li11 under [CC0](https://creativecommons.org/publicdomain/zero/1.0/deed.en)
for the board-game event, explicitly labeled stock. It was downloaded, visually inspected
and checked in the browser with its credit/date/license and participant disclaimer.
The preview selected two photos total; no text or published reader data changed.

The four local editions were subsequently republished with image-only corrections and
backups. Ballard has the two selected images; the other editions have excluded record stories
or permit streets without a verified photo match. A further November 2 search checked the library, Kadampa Center, NW 90th
Street and 28th Avenue NW. No additional recent licensed match was verified, so no old or
unrelated image was attached. The earlier `story_images_v4` added permit street matching.
`story_images_v5` adds the photo editor, visual review evidence and archived asset linkage;
a policy change invalidates prior image jobs/decisions.

Normal runs execute image jobs automatically after the last authoring job. The finish
gate opens only once every image job completes or exhausts its retries. Failed image
jobs can be retried before publication using the existing Retry step control; completed
story-writing jobs are preserved.

The **Retry photo sourcing** button at the publication review gate reruns only images
when permissions or venue assets change. Its admin-only action is
`POST /api/admin/runs/<run>/actions` with `{"action":"images"}`. It creates a new image
revision, preserves validated copy, and returns to the same publication gate afterward.
It does not reopen or republish an already-published edition.

Primary provider references: [Commons API](https://commons.wikimedia.org/wiki/Commons:API/MediaWiki),
[image metadata](https://www.mediawiki.org/wiki/API:Imageinfo),
[search](https://www.mediawiki.org/wiki/API:Search), and
[reuse requirements](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia).

Image URL, extraction, provenance, publication, reader compatibility and delivery tests
live in `apps/journalist-site/pipeline/tests`. Run `npm run check` and `npm run build`
in `apps/reader-site`, plus the relevant Vitest suites in `apps/journalist-site`.
