# Reader site

The Astro reader site serves its own public API routes and browser application. The
`/api/editions` endpoints read published edition JSON and a published-location
index from a Google Drive folder using a server-side service account; `/api/locations/*`
search and reader actions use MongoDB. Drive credentials are
never sent to the browser. The site is deployed as a Vercel server application through the
Astro Vercel adapter; it is not a static-only build.

## Public newsroom discovery

The application root opens `/reader` without requiring an operator sign-in.
Search for a community to choose among the independent newsrooms with a published
edition covering it. The same explicit newsroom **Publish** release pointer drives
this directory and the existing publication renderer; discovery never generates,
approves, publishes, or creates another edition. Uncovered communities use the
existing consented coverage-interest form; capture does not send email or initiate
newsroom work.

Opening a newsroom reads its **full combined edition**, including stories for all
covered communities. Coverage names and story location tags remain visible. Legacy
`?location=<id>&edition=<id>` links and immutable publication release links still
select their original exact edition.

Release article bodies preserve authored paragraphs and accept LF, CR and tabs,
up to 20,000 characters. Other C0 controls and DEL are rejected; identity and
headline fields stay single-line. The shared parser and canonical hash checks
read immutable payloads as stored, without normalization, rehashing or republishing.
The publisher validates new payloads with this parser before claiming publication.
Latest and exact-release routes return HTTP 502 on integrity/storage failures and
404 for a missing release or story, rather than a successful error page.

Archived newsrooms remain readable and discoverable only when `archived_at` is
numeric and finite and `archived_was_enabled === true` (or the channel is currently
enabled). Reader destinations and valid published pointers/artifacts are still
required. Merely disabling a newsroom, or archiving a previously disabled one,
does not grant public access. Archival does not rewrite releases or bypass
withdrawal: a newsroom without a current release remains unavailable at its latest
URL; exact withdrawn releases retain their warning. Published coverage snapshots
are searchable even if community setup records are no longer present.

## Reader navigation and story conversations

The landing page uses the neighborhood picker to open the existing independent-newsroom
chooser; it never chooses a publication for the reader. The reader styling adds a
Categories menu and a lead/illustrated-secondary/briefs layout while retaining the
publication's profile, covered communities, events, sponsor slots and other story sections.
Category and event links retain the selected release or private draft revision. Archive
links use the publication archive; private previews remain inside the draft context.
Email promotion continues to follow the shared email-availability policy.

Published articles include comments and **Yes, helpful** / **Needs work** feedback.
Comments accept an optional display name and render as text. Responses are separate from
immutable release content and are never enabled for private draft previews or withdrawn
releases. Legacy location/edition story links retain their own separate conversations.

`/reader/api/story-conversation` validates the exact published story through the existing
reader loaders. MongoDB stores comments in `reader_story_comments`, helpfulness in
`reader_story_feedback`, and expiring submission limits in `reader_conversation_limits`.
The reader database user needs read/write and index permissions for these collections.
Same-origin submissions are bounded and rate-limited, repeated comment retries are
deduplicated, and only comments marked `published` are returned. Mutations hold the
existing site-writer admission for their full lifetime so restore maintenance blocks new
writes without changing release or publishing authority.

## Guide the Bee Home

Each reviewed edition game is a compact bubble on its neighborhood front page, pinned by
`?location=<id>&edition=<id>`. The brief instruction, "Guess the word, one letter at a
time.", sits above the masked word. The local clue is available in a small **Hint**
disclosure, collapsed by default, with no score penalty. Players type into a single labeled letter input; incorrect letters
appear in a red, explicitly labeled miss list. There is no alphabet-button grid,
practice mode, instruction panel or pre-game leaderboard. A small reviewed last-week
winner line sits immediately after the bubble; a top-three result line appears only
after finishing. Suggested words come from the neighborhood/state name or lighter
local story topics actually present in the edition, not a flower-word bank.

The public `/reader/api/save-the-bee` endpoint keeps
answers server-side until guessed or the attempt ends. It validates each letter,
saves guesses in MongoDB, and computes the result: six misses ends the game; a win
scores 100 minus 10 per miss, and a loss scores zero. No speed scoring; equal scores
share a rank. Opening the game automatically establishes the browser's saved attempt
before revealing the masked word. There is one scored result per browser/edition.
Archived games preserve existing results but do not start new attempts. Play ends seven days after initial
publication, or earlier when an editor closes it or a newer edition goes live.

An essential HttpOnly, SameSite save cookie lasts one year across editions. Reloading
or returning with that cookie resumes the durable ranked attempt; concurrent tabs and
retried guesses cannot create a second result. Clearing cookies or using another device
loses the identity and bypasses this friendly browser rule. No email, account, device
fingerprinting, or IP-based identity is used.

Only after scoring, readers may enter a free-text name/nickname and opt into public score
sharing, with a separate reviewed next-edition shout-out permission. Skipping remains
private. Either permission can be withdrawn from the saved result, even after closing;
new consent cannot be added once finalized. Nicknames are normalized and limited to
2-24 characters; markup, controls, links/contact addresses and basic abusive terms are
rejected. All public names use text rendering, not HTML. The API retains the top 100
shared results, while the compact reader shows only the top three after finishing.
Attempts/consent expire after 90 days. Both apps must use the same replica-set MongoDB
database, and unpublished puzzles must be approved in the journalist **Publish** tab.
See the [isolated demo and editorial flow](../journalist-site/README.md#guide-the-bee-home-review-before-publishing).

## Newsroom campaign pages

- `/reader/campaign/newsroom` for professional journalists, editors, and independent publishers.
- `/reader/campaign/college-journalism` for college journalists and campus publications.
- `/reader/campaign/high-school-journalism` for high-school programs, with signup by an adult educator or adviser.
- `/reader/campaign/branded-news` for people and organizations who want to publish a local roundup under their own name or brand.

The forms capture prelaunch interest. Review leads in the MongoDB `campaign_signups` collection. The reader site's database user needs write access to that collection. Each record holds the first signup for an email and campaign, its answers, timestamp, and any supplied UTM tags. For example, use `?utm_source=partner&utm_medium=sponsorship&utm_campaign=newsroom-pilot&utm_content=draft-to-video` on an ad link. Keep UTM values free of personal information.

Reuse the Newsbee website's GA4 property and web data stream if one exists. Otherwise, create one GA4 property and web stream for the public Newsbee site in your existing Analytics account. Set `PUBLIC_GA_MEASUREMENT_ID` to the stream's `G-...` ID in the reader site's environment. In the web stream settings, turn off Enhanced Measurement's form interactions so GA4 uses the explicit signup events below.

| Event | When it fires |
| --- | --- |
| `page_view` | A campaign page loads |
| `campaign_signup_start` | A visitor first focuses a form control |
| `generate_lead` | A new signup is saved |

Mark `generate_lead` as a key event and register `campaign_audience` as an event-scoped custom dimension to compare pages. UTM parameters identify ad sources and variants. Form answers and email addresses stay in MongoDB. After release, check GA4 Realtime with a tagged campaign visit and a new test signup.

## Google Drive files

New agent-reviewed photos use `image_asset_id` to serve archived originals' reviewed
derivatives from MongoDB through the edition-scoped `/api/images/<location>` endpoint.
The component uses responsive desktop/mobile variants. Legacy URL-only photos retain
the origin cache. Reader-submitted derivatives still require current approval and are
served with `Cache-Control: no-store`. Both apps must use the same MongoDB database.

Share the Drive folder with the service account email as a Viewer. Place one `.json` file
for each published edition and a `locations.json` directory index in that folder. Use the
edition format validated in [`src/lib/reader-data.ts`](src/lib/reader-data.ts). The
[shared JSON schema](../../shared/contracts/edition.schema.json) is a historical reference,
not an automatically regenerated cloud-runtime validator.
For example:

```json
{
  "id": "edition-seattle-2026-10-19",
  "location_id": "seattle-wa",
  "location_name": "Seattle, WA",
  "window_start": "2026-10-12",
  "window_end": "2026-10-19",
  "published_at": 1792435200,
  "headline": "Seattle this week",
  "intro": "A brief introduction to this edition.",
  "items": [],
  "coverage": [],
  "corrections": []
}
```

The journalist publisher writes `locations.json` for onboarded locations with a published
edition. This powers the empty-search edition picker; MongoDB-backed community search can
also find places without an edition, return the shared additive preparation state
(`available`, `requested`, `preparing`, `ready`, or `blocked`), and offer an interest
signup. Aggregated launch-interest demand can change `available` to `requested`, but a
signup never implies readiness and requester emails are not returned by search or
newsroom queue APIs:

```json
{
  "locations": [
    {
      "id": "seattle-wa",
      "name": "Seattle, WA",
      "branch_count": 31,
      "system_count": 8
    }
  ]
}
```

Each file's JSON `location_id` and `published_at` select the latest edition for a town;
`?edition=<id>` selects that town's exact published edition, never a fallback to latest.
The publisher's canonical `<edition-id>.json` filename permits a direct exact-edition
read. Older arbitrary filenames remain supported through metadata probes.
Unfiltered bulk catalog data retains its existing per-instance 60-second cache.
Selected-location/edition and metadata-only requests bypass that bulk cache, resolve
the current channel and directory, and reread the selected mutable legacy body.
Edition documents must satisfy the runtime format above, and each edition's town
must exist in `locations.json` to be served. Files retained for removed locations remain
archived in the folder but are not returned.

### Reader read-path bounds

- Publication browse reuses the `output_channels` rows from its current list query:
  no equivalent per-publication channel lookup follows the list. Directory requests
  also read current enabled/pointer state rather than a 60-second availability snapshot.
- Verified immutable manifest/release values are cached separately (at most 100 of
  each per instance). Concurrent misses for the same database/storage/publication/
  artifact identity share one in-flight read and validation; failed loads are removed
  so retries still surface errors and can recover. Current channel/pointer reads are
  never replaced by these artifact caches.
- At most six artifact reads run concurrently per instance, shared across requests,
  publication manifests/releases and legacy metadata/body reads. This is an I/O
  concurrency bound, not a catalog-size or request-rate limit.
- Latest legacy location pages probe scalar edition headers and load only the newest
  matching edition body. Exact canonical edition routes load the directory and that
  edition only. The edition directory API and community directory use metadata-only
  reads. Local probes stop in 1 KiB chunks once the header is complete; Drive uses a
  range request and cancels its response stream after the header. Both cap probes at
  64 KiB; Mongo projects only the header from the first 65,536 Unicode characters.
  Normal publisher payloads put identity/window fields before `items`. Unusually
  large or reordered external payloads fall back to the original full JSON parser
  for compatibility; avoiding unrelated bodies for those layouts requires a persisted
  public edition index.
- Browse applies community and exact-edition selection before loading publication
  latest-release items or legacy community story bodies. Publication history is scoped
  by each manifest entry's historical coverage before browse rows are materialized,
  not by today's pointer locations. Community choices and other current-edition
  options remain available, including options whose item bodies were not needed.
  Older publication bodies are still loaded only by their exact release routes.

**Remaining bound:** global story search/deduplication and exact result/history totals
still inspect all manifest metadata, all legacy bodies for an unfiltered catalog, and
one current body per matching publication. A filtered legacy community search still
reads all that community's edition bodies to preserve story-version matching.
Thus an unfiltered 20-story page is **not** a 20-body read limit. Strict global
body-work/history pagination needs a maintained public search/history index; it is
deferred rather than silently truncating results, dropping historical coverage, or
caching stale withdrawal/availability decisions. The 1,000-publication × 52-release
regression checks a selected community/edition: 1,000 manifest reads, one body read,
zero channel point reads, and at most six simultaneous artifact reads.

Workspace Shared-drive folders are supported for listing and reading, including
paginated listings. For pipeline publishing with a service account, use a Shared
drive so the organization owns new files; sharing a personal My Drive folder
does not give a service account storage quota.

## Compare local layouts with current published editions

The local Drive stand-in is a separate data source from the deployed reader. Updating
application code does not refresh old local edition JSON. Before comparing a UX change
with production, capture the public catalog and its latest editions from the repository
root:

```sh
node apps/reader-site/scripts/snapshot-published-editions.mjs --source https://newsbee-seven.vercel.app/reader --output .local/ux-figma-qa/published-snapshots --folder 1S2uePphOd_25yandeFtQJ6iZvSz2ydYw
```

This script makes HTTP GET requests only. It downloads the public `/api/editions`
catalog, then requests each edition with the exact community and edition IDs from that
catalog. Optional public community counts are included when available and valid. It
preserves the complete edition payload and item order, including optional media fields;
invalid contracts or mismatched pinned metadata stop the capture instead of dropping
stories. It does not publish, change production data, read credentials, or write environment
settings.

Each run creates a new timestamped directory under `--output`, leaving previous
fixtures intact. The printed `driveRoot` contains the `--folder` subdirectory, whose
`locations.json` and edition JSON files are ready for the local reader. `manifest.json`
and the source `catalog.json` sit outside that reader folder. The manifest records the
source URLs, capture time, exact edition IDs, story counts, and SHA-256 hashes. A run
that exits successfully and writes its manifest is a complete snapshot.

Restart both local apps with `NEWSBEE_MODE=local`, `NEWSBEE_LOCAL_DRIVE_DIR` set to the
printed `driveRoot`, and `NEWSBEE_READER_DRIVE_FOLDER_ID` matching `--folder`. Keep their
MongoDB settings on the isolated test database. The selected `output_channels` document
takes precedence over the fallback folder variable, including in local mode: it must
be absent or select this same ordinary folder ID. A `mongo:` channel reads its own
stored files instead of this filesystem snapshot. The script does not change channels
or restart applications. Restarting also clears the reader's 60-second catalog cache.

Use the captured community IDs when opening editions; old local aliases may differ
from the deployed catalog. Compare the loaded edition ID and complete story count with
the manifest before judging layout differences. This public snapshot contains edition
content, not MongoDB-backed puzzles, stored photo assets, submissions, or reader data.
See the [recorded deployment parity check](../../Docs/reader-deployment-parity.md) for
the comparison that prompted this workflow.

## Environment

Create a Google Cloud project, enable the Google Drive API, and create a service account
with a JSON key. Share the Drive folder with that service account's email as a Viewer.
Keep the JSON key private and do not commit it. Set the service-account email, private key,
as server-side environment variables on the reader-site deployment in Vercel (and in local
development when needed):

- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: service account email with Viewer access to the folder.
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: service account private key in PEM format. Store
  it as a secret; escaped `\n` newlines are supported.
- `NEWSBEE_OUTPUT_CHANNEL_ID`: MongoDB `output_channels` document ID, default `reader-site`.
  Both reader and publisher first use this document's `drive_folder_id`. It must have a
  boolean `enabled: true` and a valid folder ID. Disabled/malformed documents, missing
  MongoDB configuration and database failures surface as errors, without fallback.
  The discovery-only `GET /reader/api/editions` handles a valid, explicitly disabled
  legacy channel as an absent legacy source so independent publications remain
  discoverable. It does not enable that channel or read a fallback folder.
  Malformed configuration and database/storage errors still log and return 503.
- `NEWSBEE_READER_DRIVE_FOLDER_ID`: Fallback only when the selected channel document is
  absent. Defaults to `1S2uePphOd_25yandeFtQJ6iZvSz2ydYw`; match both sites' settings
  and grant the reader MongoDB identity read access to `output_channels`.
- `NEWSBEE_MODE=cloud`: read Google Drive in Vercel. Local mode is the default and reads
  the local Drive stand-in instead; credentials alone do not switch it to cloud mode.
- `NEWSBEE_LOCAL_DRIVE_DIR` (optional, local only): local Drive root. The reader folder is
  a subfolder named by the resolved channel/fallback folder ID; the local launcher sets this root.
- `NEWSBEE_ARTIFACT_STORE=mongo` (optional): read editions from the journalist service's
  MongoDB `artifacts` collection instead of Drive; the Google variables above are then not needed.
- `MONGODB_URI`: private MongoDB Atlas connection string.
- `MONGODB_DATABASE`: shared database for signups, reader submissions, engagement and
  community lookup. Use the same database as the journalist service for inbox and map aggregation.
- `NEWSBEE_EMAIL_MANAGEMENT_SECRET`: server-only signing secret for publication email
  preference and unsubscribe links. Configure the same value in the journalist service.

For legacy editions, the reader serves every location listed in the resolved folder's
`locations.json`, which the journalist site rewrites on each publish. Share the configured Drive
folder with the service account email as a Viewer. The service account only requests
Drive's read-only scope. The MongoDB database user needs read/write access to
`reader_interest_signups`, the `publication_email_*` subscription/consent/suppression collections, `reader_story_submissions`, `obituary_submissions`, `reader_engagement`, `source_suggestions`, `story_reports`, `geographic_places`, `geographic_search_cache`, and
`geographic_search_leases`, plus read access to `census_places` and
`locations` (community search lists onboarded communities). Geographic search creates a TTL index on its shared cache. MongoDB creates a unique
`(location_id, email)` index in the signup collection so repeat signups are idempotent.
Published publication releases use a separate explicit publication/location consent form.
Legacy reader interest records are not copied into or interpreted as publication email consent.

## Pages

- `/reader`: community search and server-rendered neighborhood editions, with the five
  best-ranked news stories, a seven-day events view and nonempty topic sections.
  `&section=<topic>` opens all stories in a topic; `&section=events&day=YYYY-MM-DD`
  opens a day's events. Topics are derived in the reader by `shared/topics.ts`;
  this does not change pipeline selection or publishing. Topics include **Local Sports**, and
  home sales and permits appear under **Housing & Development**. Digest entries (home sales,
  permits, scores, death notices) are short items from their source facts, with a link to the
  original.
  Every edition has a **Got a story for your neighbours?** call-out and an **All stories**
  link (`&section=all`) that includes every published news item, alert and event, including
  items outside the preview grids. Headlines and cards open an in-app article
  (`?location=<id>&edition=<id>&story=<story-id>`), never the external source.
  Article pages show the entire saved authored text without preview clipping, when/where,
  a credited approved photo or a photo placeholder, **Print story**, **Share story**, and
  **Report a problem** (goes to the editor Inbox). Share uses the native share sheet or
  copies the edition-pinned article URL, with a manual-copy fallback. Source attribution
  and the optional external source link appear only below that article, not in an
  aggregate dropdown on the main page. Printing omits navigation and controls.
  Older items without a story ID have edition-scoped `item:<position>` article links;
  they do not send ID-based engagement or reports. Internal source maps, filtering
  outcomes and ranks are not rendered or linked. An optional `&edition=<published-id>`
  opens that exact edition for the chosen location and is retained on section/event links.
  Missing or cross-location edition IDs return 404 rather than showing the latest edition.
- `/reader/sources`: legacy links redirect to the newsletter without querying map data.
- `/reader/suggest?location=…`: **Suggest a source**, linked from edition notes;
  sends suggestions to the editor Inbox without exposing internal editorial data.
- `/reader/share?location=…`: the **Share your story** form; with `&story=<id>`, an
  approved story's public page. Optional photos require a description, explicit public
  photo credit and publication permission. Still JPEG/PNG/WebP uploads are limited to
  2 MB and 25 million decoded pixels, resized to fit 1600 pixels and re-encoded as JPEG
  without EXIF/GPS metadata. The sanitized image is stored with the pending submission
  in MongoDB (no new storage service); an editor approves the image and story together.
  Approved photos and their credit can accompany newly authored editions.
- `/reader/remember?location=…`: the family remembrance form; with `&notice=<id>`, an
  approved notice's public page.
- `/reader/subscribe?location=…`: weekly-update signup.

`/source-map` and `/interest-usage` are separate read-only pages served by the journalist
app, not reader pages or public newsletter links. Both accept the shared
`NEWSBEE_INTERNAL_PASSWORD` without journalist sign-in; their `/api/maps/*` data is
password-gated server-side. The password does not grant administrator privileges.
Keep that value server-side on the journalist service, never in reader/public-prefixed
variables. See [deployment and access configuration](../../Docs/deployment.md).

Locally, `npm run local` in `../journalist-site` starts this site with the console and a
shared local MongoDB; see [Run locally](../../README.md#run-locally).

## API routes

Story photos use a source-credited image pipeline with public-HTTPS validation, bounded
delivery/cache, event venue photos and an optional last-resort stock pass. Missing or
failed photos leave text-only stories. No additional configuration is required;
see [the image pipeline](../../Docs/image-pipeline.md).

- `GET /api/editions`: lists towns and their latest edition metadata.
- `GET /api/images/<location_id>?edition=<id>&item=<index>`: serves the approved raster
  image for an item in that community's published edition. Arbitrary image URLs are not accepted.
- `GET /api/editions/<location_id>[?edition=<id>]`: returns the latest or a specific
  published edition for that town; IDs from other locations are not served.
- `GET /api/locations/search?q=<prefix>[,%20ST]`: searches Census towns, reviewed communities,
  and saved geographic communities.
- `GET /api/locations/search?q=<community>&discover=true`: explicitly searches US neighborhoods
  and towns through Photon/OpenStreetMap, using the same MongoDB cache and provider throttle
  as editor onboarding. `NEWSBEE_GEOCODER_URL` can override the HTTPS Photon endpoint.
- `GET /api/locations/<location_id>`: resolves a town in the directory.
- `POST /api/locations/<location_id>/interest`: accepts `{ "email": "...", "consent": true }`,
  validates explicit consent to future weekly editions, and saves the signup in MongoDB;
  addresses are never returned by a public endpoint. The optional boolean
  `launch_notification` records additional launch-notification consent; it defaults to `false`.
  A `true` value records the first launch-interest timestamp; `false` records the first
  subscription timestamp. Counting follows the explicit submitted intent, not an inferred
  reader location or a search event.
- `POST /api/locations/<location_id>/suggest`: `{ name, url, section, why? }`, a reader's
  source suggestion, pending until an editor approves it.
- `POST /api/locations/<location_id>/report`: `{ message, edition_id?, story_id?, headline? }`,
  a problem report about a published story, sent to the editor Inbox.

- `POST /api/locations/<location_id>/stories`: a neighbour's story for **Share your story**
  (headline, topic, story, optional date and link, name, email, credit choice, consent),
  stored as pending in `reader_story_submissions` for an editor to review. Accepts the
  existing JSON format without a photo, or multipart form data with optional `image`,
  `image_caption`, `image_credit`, `image_consent=on` and `consent=on`. Whole requests are
  bounded even without Content-Length. Invalid/unsupported photos return 422 and oversized
  uploads return 413; nothing is saved on validation failure.
- `GET /api/locations/<location_id>/stories/<story_id>/image`: sanitized photo only for
  that community's approved submission; pending, rejected, missing and cross-community
  requests return 404. Responses are not cached so reversing approval revokes access.
- `POST /api/locations/<location_id>/remembrance`: a family death notice, stored as pending
  in `obituary_submissions`.
- `POST /api/engagement`: anonymous reading signals (`view` with the stories shown, `open`
  of a full in-app article, completed `share`), stored in `reader_engagement` for ranking. No cookies, IP
  addresses or user identifiers are kept. Events must reference a published edition and
  its own stories. One view event counts as one edition read, not one read per story.
  Reloads and return visits count again; these are not unique readers or email opens.
  Tracking can be blocked. Article opens/shares affect ranking but not the usage map's
  edition-read total.

The paths above are service-relative; publicly they are under `/reader/api/`.
Astro's `/reader` base also prefixes generated assets and browser API calls.
The reader calls these same-origin routes. Google Drive content is read on the server;
the browser never receives service-account credentials. Search and edition content are
public. Interest signups require a same-origin request and are stored durably in MongoDB.
The `reader_interest_signups` collection maps each normalized email to `location_id` and
`location_name`, with `created_at`, `consented_at`, `weekly_editions: true`, and
`launch_notification`. `consent_version: "weekly-editions-v1"` covers weekly editions plus
a launch notification; `"weekly-editions-v2"` covers weekly editions only.
Repeat submissions update consent
without duplicating the email/location pair. Earlier interest-only records without these
consent fields must not be treated as weekly subscriptions unless the reader signs up again.
New signups also preserve independent `subscription_signup_at` (subscription form) and
`interest_signup_at` (launch-interest form) timestamps, once per intent and email/location.
Both intents may legitimately exist. Historical intent is not inferred from overwritten
consent flags; `legacy_signup` preserves that limitation for the internal usage map.
There is no automatic email delivery or launch-notification sender yet.
Administrators can permanently clear engagement events and launch-interest signups from the
journalist site's **Clear reader data** page; subscriptions and ambiguous older records stay.
The password-protected usage map groups these records by newsletter/requested community,
not IP geography. It returns aggregates, not signup emails, with UTC date filters and
explicit no-data/legacy-history limits; ambiguous historical intents are not fabricated.

The `/reader` landing page introduces Newsbee with a central **Find your neighborhood**
search bar. Its dropdown shows published editions when empty and community suggestions
as the reader types, with **Search all communities** embedded for broader lookup.
It does not automatically open the first
edition. Choosing a published community opens its neighborhood page; choosing any community
without a published edition opens the “we're not here yet” interest page, including saved
communities that have not published yet. **Find another neighborhood** returns to discovery.
Unpublished communities show an inline location-specific signup form with an unchecked,
required consent checkbox covering weekly editions and a launch notification.
Published editions include a weekly-editions signup, with required consent below the
button, and a footer link to `/reader/subscribe?location=<location_id>`.
That dedicated page identifies the community, provides a return link to its edition,
and asks for weekly-edition consent only, without launch-notification wording.
All signup forms support optional topic preferences and email confirmation. They explain
when delivery is unavailable rather than claiming an email was sent. See
[`Docs/newsletter-delivery.md`](../../Docs/newsletter-delivery.md) for provider setup,
preference management, unsubscribe, delivery operations, and local test-mail transport.

`/reader/browse` searches published stories across editions and provides community/topic
filters and edition history. `/reader/contact` and `/reader/become-editor` save private
community messages and branch-interest applications for review in the editorial Inbox.

The reader and journalist apps import shared typography, spacing and color tokens from
`shared/design-tokens.css`; see `Docs/design-style-guide.html`. The journalist workspace
retains its own green workspace palette and navigation.
The `?location=<location_id>` URL opens a community directly, and browser Back/Forward
navigates between discovery and selected communities.

Published editions use compact newspaper typography, ruled columns, and a lead story,
with a separate upcoming-events section. The masthead identifies the community once;
generic location/week headlines and boilerplate introductions are hidden, while editorial
headlines and substantive introductions remain. Story location lines that only repeat
the edition community are omitted; specific venues, times, and other places remain.
Story attribution and original-source links
are collected in a concise numbered list in the collapsed **Sources & edition notes**
pane at the bottom. Superscript references on stories open the pane and focus the matching
source; return links lead back to the story. Coverage notes live there too; corrections and stale-edition notices remain
visible above the stories. The pane resets to collapsed when opening another edition.

In **Find your neighborhood**, type a community name and city/state, then press **Search all
communities** (or Enter without a highlighted suggestion). Typing alone only searches the
local directory; provider lookup is explicit. A discovered community is saved for later
lookup and interest signups, not automatically onboarded or published. Selecting it opens
the published edition when available, otherwise the interest form.

For the complete local cloud stack, use `npm run local` in
[`../journalist-site`](../journalist-site/README.md); it supplies the local MongoDB and
Drive stand-ins to both apps. Python is not required.

For standalone development, run `npm ci`, `npm run check`, and `npm run dev` from this
directory and set the server-side environment variables above before using the API.
The TypeScript pipeline in the journalist app handles ingestion, edition authoring and
publishing; this app serves only reader operations.

Deploy from the repository root using the services in [`../../vercel.json`](../../vercel.json).
The reader is public at `/reader`; the journalist app owns the other paths.
Both services share project environment variables. Set the reader's email/private key
in `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, and the
journalist writer's credentials separately in `GOOGLE_SERVICE_ACCOUNT_JSON`.
For standalone `npm run dev`, open `http://127.0.0.1:4321/reader`.
