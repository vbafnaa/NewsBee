# Reader site

The Astro reader site serves its own public API routes and browser application. The
`/api/editions` endpoints read published edition JSON and a published-location
index from a Google Drive folder using a server-side service account; `/api/locations/*`
search and reader actions use MongoDB. Drive credentials are
never sent to the browser. The site is deployed as a Vercel server application through the
Astro Vercel adapter; it is not a static-only build.

## Google Drive files

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
also find places without an edition and offer an interest signup:

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

Edition filenames are not significant; each file's JSON `location_id` and `published_at`
select the latest edition for a town; `?edition=<id>` selects that town's exact published
edition. Drive data is cached in each running site instance
for 60 seconds. Edition documents must satisfy the runtime format above, and each edition's town
must exist in `locations.json` to be served. Files retained for removed locations remain
archived in the folder but are not returned.

Workspace Shared-drive folders are supported for listing and reading, including
paginated listings. For pipeline publishing with a service account, use a Shared
drive so the organization owns new files; sharing a personal My Drive folder
does not give a service account storage quota.

## Environment

Create a Google Cloud project, enable the Google Drive API, and create a service account
with a JSON key. Share the Drive folder with that service account's email as a Viewer.
Keep the JSON key private and do not commit it. Set the service-account email, private key,
as server-side environment variables on the reader-site deployment in Vercel (and in local
development when needed):

- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: service account email with Viewer access to the folder.
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: service account private key in PEM format. Store
  it as a secret; escaped `\n` newlines are supported.
- `NEWSBEE_READER_DRIVE_FOLDER_ID`: Drive folder the journalist site publishes editions
  to. Defaults to `1S2uePphOd_25yandeFtQJ6iZvSz2ydYw`; set the same value on both sites.
- `NEWSBEE_MODE=cloud`: read Google Drive in Vercel. Local mode is the default and reads
  the local Drive stand-in instead; credentials alone do not switch it to cloud mode.
- `NEWSBEE_LOCAL_DRIVE_DIR` (optional, local only): local Drive root. The reader folder is
  a subfolder named by `NEWSBEE_READER_DRIVE_FOLDER_ID`; the local launcher sets this root.
- `NEWSBEE_ARTIFACT_STORE=mongo` (optional): read editions from the journalist service's
  MongoDB `artifacts` collection instead of Drive; the Google variables above are then not needed.
- `MONGODB_URI`: private MongoDB Atlas connection string.
- `MONGODB_DATABASE`: shared database for signups, reader submissions, engagement and
  community lookup. Use the same database as the journalist service for inbox and map aggregation.

There are no output channels: the reader serves every location listed in the folder's
`locations.json`, which the journalist site rewrites on each publish. Share the configured Drive
folder with the service account email as a Viewer. The service account only requests
Drive's read-only scope. The MongoDB database user needs read/write access to
`reader_interest_signups`, `reader_story_submissions`, `obituary_submissions`, `reader_engagement`, `source_suggestions`, `story_reports`, `geographic_places`, `geographic_search_cache`, and
`geographic_search_leases`, plus read access to `census_places` and
`locations` (community search lists onboarded communities). Geographic search creates a TTL index on its shared cache. MongoDB creates a unique
`(location_id, email)` index in the signup collection so repeat signups are idempotent.

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

- `GET /api/editions`: lists towns and their latest edition metadata.
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
All signup forms share the same submission behavior and explain that email delivery is not active yet.

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
