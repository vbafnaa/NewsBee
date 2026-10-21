# Reader site

The Astro reader site serves its own public API routes and browser application. The
`/api/editions` and `/api/locations` endpoints read published edition JSON and a location
index from a Google Drive folder using a server-side service account. Drive credentials are
never sent to the browser. The site is deployed as a Vercel server application through the
Astro Vercel adapter; it is not a static-only build.

## Google Drive files

Share the Drive folder with the service account email as a Viewer. Place one `.json` file
for each published edition and a `locations.json` directory index in that folder. Use the
edition contract in [`../../shared/contracts/edition.schema.json`](../../shared/contracts/edition.schema.json).
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

`locations.json` contains all towns available to the location picker, including towns
without an edition:

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
select the latest edition for a town. Drive data is cached in each running site instance
for 60 seconds. Edition documents must use the shared contract, and each edition's town
must exist in `locations.json`.

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
- `NEWSBEE_OUTPUT_CHANNEL_ID`: `_id` of this reader's document in `output_channels`.
  Defaults to `reader-site`.
- `MONGODB_URI`: private MongoDB Atlas connection string.
- `MONGODB_DATABASE`: database where reader interest signups are stored.

The Drive folder ID is read from `output_channels.drive_folder_id` on the document whose
`_id` is `reader-site`; configure it in the journalist site's Output channel page. The
reader site does not use a Drive folder ID environment variable. Share the configured Drive
folder with the service account email as a Viewer. The service account only requests
Drive's read-only scope. The MongoDB database user needs read/write access to
`reader_interest_signups`, `geographic_places`, `geographic_search_cache`, and
`geographic_search_leases`, plus read access to `output_channels`, `census_places`, and
`source_configs`. Geographic search creates a TTL index on its shared cache. MongoDB creates a unique
`(location_id, email)` index in the signup collection so repeat signups are idempotent.
When the channel's `enabled` field is `false`, edition listing and edition detail APIs
return HTTP 503 without serving cached edition responses.

## API routes

- `GET /api/editions`: lists towns and their latest edition metadata.
- `GET /api/editions/<location_id>`: returns the latest edition for a town.
- `GET /api/locations/search?q=<prefix>[,%20ST]`: searches Census towns, reviewed communities,
  and saved geographic communities.
- `GET /api/locations/search?q=<community>&discover=true`: explicitly searches US neighborhoods
  and towns through Photon/OpenStreetMap, using the same MongoDB cache and provider throttle
  as editor onboarding. `NEWSBEE_GEOCODER_URL` can override the HTTPS Photon endpoint.
- `GET /api/locations/<location_id>`: resolves a town in the directory.
- `POST /api/locations/<location_id>/interest`: validates and stores an interest email in
  MongoDB; addresses are never returned by a public endpoint.

The paths above are service-relative; publicly they are under `/reader/api/`.
Astro's `/reader` base also prefixes generated assets and browser API calls.
The reader calls these same-origin routes. Google Drive content is read on the server;
the browser never receives service-account credentials. Search and edition content are
public. Interest signups require a same-origin request and are stored durably in MongoDB.

In **Choose your edition**, type a community name and city/state, then press **Search all
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
