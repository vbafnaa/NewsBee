# Newsbee cloud architecture

The active implementation is TypeScript. The earlier persistent Python worker, SQLite
backend and review console are historical reference under `archive/python/`; they are
not dependencies of the cloud runtime. Earlier design and roadmap assets in this
directory describe the project's evolution, not necessarily its current deployment.

| Component | Runtime and responsibility |
| --- | --- |
| `apps/journalist-site` | Next.js console, Google sign-in, admin APIs and pipeline jobs |
| `apps/reader-site` | Astro server application; public edition/directory APIs and interest signups |
| MongoDB Atlas | Locations, source configuration, jobs, runs, admins, output channels and signups |
| Google Drive | Pipeline artifacts, published edition JSON, directory indexes and saved email previews |
| Hosted model APIs | Configurable ordered fallback providers; Ollama is local-only |
| Vercel Cron | Optional minute calls to the protected journalist `/api/pipeline/tick` route; currently disabled |

Pipeline work is split into MongoDB jobs for collection, authoring and publication rather
than a continuously running Python worker. Each source records its outcome independently;
editorial checks hold invalid stories before publication. A channel selects the towns
that publish to its Drive folder. Email previews are saved, never sent.

The reader reads channel configuration and stores interest signups in MongoDB; published
content comes from Drive using a server-side service account. Credentials never go to
the browser. Journalist access checks enabled accounts in `journalist_admins`.

## Deployment and local development

Deploy both apps as services of one Vercel project rooted at the repository root.
Root `vercel.json` routes `/reader` and its descendants to Astro and all other
requests to Next.js, and scopes the private queue consumer to the journalist service.
The services do not call each other over HTTP, so no bindings are required. Minute
Cron recovery is disabled. Configure separate Drive permissions: writer for the
pipeline, Viewer for the reader. Since environment variables are project-shared,
use `GOOGLE_SERVICE_ACCOUNT_JSON` for the writer and the separate email/private-key
variables for the reader.
Keep all credentials in hosting environment secrets, never in checked-in configuration.

The supported local launcher is `npm --prefix apps/journalist-site run local`. It starts
both apps, a persistent local MongoDB and scheduler ticks, replacing Drive with an ignored
local folder. Node 24 and Ollama (or configured hosted model providers) are sufficient.
No Python services are started.

Detailed variables, bootstrap steps and commands:
[journalist/pipeline guide](../apps/journalist-site/README.md) and
[reader guide](../apps/reader-site/README.md).
