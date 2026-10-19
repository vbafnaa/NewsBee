# Journalist site

Next.js/TypeScript operations console. Google OAuth is restricted to enabled accounts in
the MongoDB `journalist_admins` collection. The browser calls this site's same-origin admin
proxy; it never receives `ADMIN_API_TOKEN`. The site checks the account list at sign-in and
on every protected page/API request, so disabling an account revokes its access immediately.
The backend independently checks the matching `NEWSBEE_ADMIN_API_TOKEN`. Google sign-in
uses an OAuth web client, not a service account: configure the Google OAuth consent screen,
create a Web application OAuth client, and register
`https://<journalist-host>/api/auth/callback/google` as its authorized redirect URI. The
journalist site does not need Google Drive access or service-account credentials.
Source management and administrator management are available on the protected `/sources`
and `/administrators` pages, linked from the persistent left navigation.

Set these environment variables before running or deploying:

- `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`: Google OAuth client credentials. Register
  `https://<journalist-host>/api/auth/callback/google` as an authorized redirect URI.
- `AUTH_SECRET`: a random, private Auth.js session secret.
- `MONGODB_URI`: private connection string for MongoDB Atlas.
- `MONGODB_DATABASE`: database containing journalist accounts, source configs, and output channel settings.
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
access to `source_configs` and `output_channels`.

Run `npm install` and `npm run dev` from this directory for local development. The backend
must be reachable and configured with an admin token. Production deployment also requires
the durable backend and worker described in
[`Docs/production-architecture-decisions.md`](../../Docs/production-architecture-decisions.md).

The dashboard and `/sources` page read the configured library websites, government
platforms, and state newsroom feeds from the MongoDB `source_configs` collection. Source
changes update those MongoDB documents; runtime ingestion still uses the checked-in
configuration files. The dashboard's separate onboarded-location settings use the backend
API. It also triggers ingestion, shows job status, and links to the `/output-channel` page.
That page manages the `reader-site` document in `output_channels`; disabling the channel
makes the reader's edition API routes return HTTP 503 until it is re-enabled. The page also
stores the Google Drive folder ID in `drive_folder_id`, which the reader site uses to locate
its `locations.json` and edition JSON files. Share that folder with the reader site's Google
service account as a Viewer. No other output destinations or editorial approval controls
are supported.

The reader output channel document has this shape:

```json
{
  "_id": "reader-site",
  "name": "Newsbee reader site",
  "url": "https://newsbee-reader-site.vercel.app",
  "drive_folder_id": "1S2uePphOd_25yandeFtQJ6iZvSz2ydYw",
  "enabled": true
}
```
