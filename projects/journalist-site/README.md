# Journalist site

Next.js/TypeScript operations console. Google OAuth is restricted to enabled accounts in
the MongoDB `journalist_admins` collection. The browser calls this site's same-origin admin
proxy; it never receives `ADMIN_API_TOKEN`. The site checks the account list at sign-in and
on every protected page/API request, so disabling an account revokes its access immediately.
The backend independently checks the matching `NEWSBEE_ADMIN_API_TOKEN`.
Administrator management is available on the protected `/administrators` page.

Set these environment variables before running or deploying:

- `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`: Google OAuth client credentials. Register
  `https://<journalist-host>/api/auth/callback/google` as an authorized redirect URI.
- `AUTH_SECRET`: a random, private Auth.js session secret.
- `MONGODB_URI`: private connection string for MongoDB Atlas.
- `MONGODB_DATABASE`: database containing the journalist account collection.
- `BACKEND_API_URL`: backend origin, for example `https://api.example.com`.
- `ADMIN_API_TOKEN`: private server-to-server token; must match the backend's
  `NEWSBEE_ADMIN_API_TOKEN` and be at least 32 ASCII characters.

Provision an account by inserting a document into the `journalist_admins` collection:

```json
{ "email": "editor@example.com", "enabled": true }
```

Create a unique index on `email` and store addresses in lowercase. Only documents with
`enabled: true` are authorized; the administrators page can add or re-enable an account. Set
`enabled` to `false` or remove the document to revoke access. The MongoDB database user
should have only the permissions needed to read and update this collection.

Run `npm install` and `npm run dev` from this directory for local development. The backend
must be reachable and configured with an admin token. Production deployment also requires
the durable backend and worker described in
[`Docs/production-architecture-decisions.md`](../../Docs/production-architecture-decisions.md).

The first version edits source settings for onboarded locations, triggers ingestion, shows
job status, and lists the existing reader channel. Reader publication remains automatic;
there is no channel toggle or editorial approval action yet.
