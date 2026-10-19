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

## Environment

Set these server-side variables in Vercel and local development:

- `GOOGLE_DRIVE_FOLDER_ID`: ID of the shared Drive folder.
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: service account email with Viewer access to the folder.
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: service account private key in PEM format. Store
  it as a secret; escaped `\n` newlines are supported.
- `MONGODB_URI`: private MongoDB Atlas connection string.
- `MONGODB_DATABASE`: database where reader interest signups are stored.

The service account only requests Drive's read-only scope. MongoDB creates a unique
`(location_id, email)` index in the `reader_interest_signups` collection so repeat
signups are idempotent.

## API routes

- `GET /api/editions`: lists towns and their latest edition metadata.
- `GET /api/editions/<location_id>`: returns the latest edition for a town.
- `GET /api/locations/search?q=<prefix>[,%20ST]`: searches `locations.json`.
- `GET /api/locations/<location_id>`: resolves a town in the directory.
- `POST /api/locations/<location_id>/interest`: validates and stores an interest email in
  MongoDB; addresses are never returned by a public endpoint.

The reader calls these same-origin routes. Google Drive content is read on the server;
the browser never receives service-account credentials. Search and edition content are
public. Interest signups require a same-origin request and are stored durably in MongoDB.

Run `npm install`, `npm run check`, and `npm run dev` from this directory for local
development. Set the server-side environment variables above before using the API. The
Python backend remains responsible for ingestion, edition authoring, and any other
non-reader operations; these Astro routes replace only the reader-facing API.
