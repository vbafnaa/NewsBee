# Newsbee production architecture decisions

This records the selected direction for moving the local prototype toward production.
“Selected” does not mean the integration is already implemented; see current status below.

## Selected stack

| Area | Direction |
| --- | --- |
| Reader website | Keep Astro in `projects/website`; deploy independently, including on Vercel. |
| Journalist/admin website | Next.js with TypeScript in `projects/journalist-site`; Google sign-in restricted to enabled accounts in MongoDB Atlas. |
| Admin capabilities, first release | Manage onboarded library and government source settings, view the reader output channel, trigger ingestion, and inspect job status. |
| Structured application data | MongoDB Atlas is the selected hosted database direction. |
| Ingestion evidence files | Google Drive is the selected initial archive location. It requires a Drive API integration and is not implemented as runtime storage yet. |
| Model inference | Select a provider by configuration: local Ollama for development or Google Gemini API for hosted use. |
| Worker execution | Run the source-gathering worker on a persistent worker host. Vercel is for the reader/admin web applications, not the current long-running worker. |

## Runtime boundaries

The reader and journalist sites are separate clients of the backend API. The reader site
displays published editions. The journalist site is an authenticated operations interface;
it does not replace the ingestion worker. A server-side journalist-site API proxy keeps the
backend admin token out of browser code. The backend independently verifies that token on
every admin endpoint.

Ingestion jobs can take longer than a short serverless request, perform external source
fetches, and depend on a continuously running queue worker. Keep the worker and durable job
queue outside Vercel unless the pipeline is redesigned around a durable queue and bounded,
idempotent serverless tasks.

## Current implementation status

- The reader is Astro in `projects/website`.
- The journalist site checks the MongoDB `journalist_admins` collection at sign-in and for
  every protected page/API request. Account documents contain a lowercase `email` and
  `enabled: true`; administrators can add or re-enable accounts from the dashboard, and
  disabling or deleting an account revokes access.
- The journalist site and protected backend endpoints provide an initial interface for
  source settings, manual ingestion, job status, and the existing automatic reader channel.
- The model provider setting supports local Ollama and Gemini API.
- The backend still uses local SQLite and filesystem evidence storage; moving its application
  data to MongoDB Atlas and evidence files to Google Drive remains future work. The journalist
  site's separate MongoDB account lookup does not change backend storage. A production
  queue/worker host and deployment-specific secret management are also future work. Do not
  deploy the current backend as a serverless Vercel function and assume its local data will
  persist.
- The existing reader output publishes automatically after edition authoring. The initial
  journalist interface reports this channel but does not add a new approval workflow or
  toggle publishing.

## Required deployment secrets and configuration

Keep credentials in the hosting platform’s encrypted environment or a secret manager;
never commit them:

- Journalist site: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`,
  `MONGODB_URI`, `MONGODB_DATABASE`, `BACKEND_API_URL`, and `ADMIN_API_TOKEN`.
- Backend: `NEWSBEE_ADMIN_API_TOKEN` must match `ADMIN_API_TOKEN`.
- Hosted model: set `NEWSBEE_MODEL_PROVIDER=gemini` and `NEWSBEE_GEMINI_API_KEY`;
  `NEWSBEE_GEMINI_MODEL` optionally selects a model (default `gemini-2.5-flash`).
- Reader deployment: set `PUBLIC_API_URL` in the reader build, `NEWSBEE_WEBSITE_URL` in the
  backend, and backend `NEWSBEE_CORS_ORIGINS` to a JSON array of trusted reader origins.
