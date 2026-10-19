# Journalist site

Next.js/TypeScript operations console. Google OAuth is restricted to enabled accounts in
the MongoDB `journalist_admins` collection. The browser calls this site's same-origin admin
proxy; it never receives `ADMIN_API_TOKEN`. The site checks the account list at sign-in and
on every protected page/API request, so disabling an account revokes its access immediately.
The backend independently checks the matching `NEWSBEE_ADMIN_API_TOKEN`. Google sign-in
uses an OAuth web client, not a service account: configure the Google OAuth consent screen,
create a Web application OAuth client, and register
`https://<journalist-host>/api/auth/callback/google` as its authorized redirect URI. The
pipeline's separate Drive writer uses the service account described below.
Source management and administrator management are available on the protected `/sources`
and `/administrators` pages, linked from the persistent left navigation.

Set these environment variables before running or deploying:

- `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`: Google OAuth client credentials. Register
  `https://<journalist-host>/api/auth/callback/google` as an authorized redirect URI.
- `AUTH_SECRET`: a random, private Auth.js session secret.
- `MONGODB_URI`: private connection string for MongoDB Atlas.
- `MONGODB_DATABASE`: database containing journalist accounts, source configs, and output channel settings.
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, or
  `GOOGLE_SERVICE_ACCOUNT_JSON`: server-only service-account credentials used by the
  journalist site to read and write pipeline artifacts in Google Drive. Use a dedicated
  account separate from the reader's service account, and grant this account Editor access
  to the output channel's Drive folder. Keep the reader site's service account read-only.
- `NEWSBEE_GEMINI_API_KEY` (or `GOOGLE_AI_STUDIO_API_KEY`): Google AI Studio API key for
  Gemini-powered story ranking and edition writing. This must stay server-side and should
  never use a `NEXT_PUBLIC_` variable.
- `NEWSBEE_GEMINI_MODEL` (optional): Gemini model name; defaults to `gemini-2.5-flash`.
- `NEWSBEE_READER_SITE_URL` (optional): initial reader URL inserted into `output_channels` the first time an administrator opens Output channel. Defaults to `https://newsbee-reader-site.vercel.app`.
- `BACKEND_API_URL`: backend origin, for example `https://api.example.com`.
- `ADMIN_API_TOKEN`: private server-to-server token; must match the backend's
  `NEWSBEE_ADMIN_API_TOKEN` and be at least 32 ASCII characters.

Provision an account by inserting a document into the `journalist_admins` collection:

```json
{ "email": "editor@example.com", "enabled": true }
```

Create a unique index on `email` and store addresses in lowercase. Only documents with
`enabled: true` are authorized; the administrators page can add or re-enable an account. Set
`enabled` to `false` or remove the document to revoke access. Grant the MongoDB database user read/update access to `journalist_admins` and read/write
access to `source_configs`, `output_channels`, `data_gathering_runs`, and
`source_ingestion_state`.

Run `npm install` and `npm run dev` from this directory for local development. The backend
must be reachable and configured with an admin token. Production deployment also requires
the durable backend and worker described in
[`Docs/production-architecture-decisions.md`](../../Docs/production-architecture-decisions.md).

The dashboard and `/sources` page read the configured library websites, government
platforms, and state newsroom feeds from the MongoDB `source_configs` collection. Source
changes update those MongoDB documents. The existing Python worker continues to use the
checked-in configuration files; the new TypeScript staged pipeline reads MongoDB source
configs. The dashboard's separate onboarded-location settings use the backend
API. It also triggers ingestion, shows job status, and links to the `/output-channel` page.
That page manages the `reader-site` document in `output_channels`; disabling the channel
makes the reader's edition API routes return HTTP 503 until it is re-enabled. The page also
stores the Google Drive folder ID in `drive_folder_id`, which the reader site uses to locate
its `locations.json` and edition JSON files. Share that folder with the reader site's Google
service account as a Viewer. There are no other output destinations or separate editorial
approval workflow.

The output-channel page also stores `selected_source_ids` in `output_channels` and provides
manual, one-request-at-a-time source and edition stages. Source artifacts live under the
configured channel folder at
`.newsbee-pipeline/sources/<source-id>/<run-id>/`; edition intermediate artifacts live under
`.newsbee-pipeline/editions/<location-id>/<run-id>/`. Only published edition JSON files are
written to the Drive folder root for the reader site. Source-run stages are `gather` and
`normalize`; channel edition stages are `rank`, `write`, and `publish`. A successful gather
records the period and timestamp in `source_ingestion_state`; every stage's status and Drive
artifact ID is recorded in `data_gathering_runs`. Each run snapshots its channel's Drive
folder ID so all of its later stages continue using the same folder.

The TypeScript pipeline currently supports the configured RSS/Atom, iCalendar, JSON-LD,
Legistar, and CivicClerk inputs. Washington state-specific filtering lives under
`data-gathering-pipeline/states/WA`. The rank and write stages require the Google AI Studio
Gemini API key and fail with a recorded stage error if the key or model is unavailable.
This staged implementation does not yet reproduce the Python pipeline's BiblioCommons/
Trumba discovery, USGS/Wikipedia/Bluesky enrichment, geographic branch matching, full
editorial publication checks, or retry-safe model fallback behavior; the existing Python
worker remains unchanged.

The reader output channel document has this shape:

```json
{
  "_id": "reader-site",
  "name": "Newsbee reader site",
  "url": "https://newsbee-reader-site.vercel.app",
  "drive_folder_id": "1S2uePphOd_25yandeFtQJ6iZvSz2ydYw",
  "selected_source_ids": [],
  "enabled": true
}
```
