# Local backend

One modular backend owns Stage 1 workflows and exposes one local API. Modules
are logical boundaries, not independently deployed services. The FastAPI app
is `api\app.py`; run it through the repository's local launcher.

## Entry points

`api\` holds HTTP transport code. Scheduled and manual jobs enter through
`modules\orchestration\`; they do not need to call the backend over HTTP.
The website and review console use the local API rather than reading private
backend storage directly.

## Module ownership

| Folder under `modules\` | Responsibility |
| --- | --- |
| `orchestration\` | Scheduling, dispatching onboarded-source runs, run state, and retry coordination |
| `source_connectors\pipelines\` | Source-agent workflows that fetch, extract, and retain source evidence |
| `source_connectors\connectors\` | Replaceable source-specific scraping and extraction implementations |
| `story_processing\` | Normalization, deduplication, linking ongoing stories, and evidence reconciliation |
| `communities\` | Community identity, coverage scope, and location-scoped story candidates |
| `editions\` | Stage 1 authoring: `stories.py` deduplicates events into stories, `drafting.py` ranks, writes, checks and publishes |
| `editorial\planning\` | Selecting candidates and planning an edition |
| `editorial\writing\` | Producing full stories with source attribution |
| `editorial\publication_checks\` | Evidence and policy checks with explicit publication outcomes |
| `editorial\review\` | Human-review exceptions and recorded decisions |
| `editorial\edition_assembly\` | Assembling approved stories and separate labeled ad slots |
| `editorial\corrections\` | Correction workflow and history |
| `publishing\` | Local releases, published stories, editions, and archives |
| `email_previews\` | Email previews derived from published editions and delivered only to a local mail sink |
| `ad_placements\` | Separate ad-slot data and placement boundaries, not advertiser intake or payments |

These are ownership boundaries, not a claim that every module is implemented.
`editorial\publication_checks\policy.py` implements conservative private-POC eligibility;
`editorial\corrections\withdrawals.py` implements audited withdrawal and future suppression.
Review queues, maintained reporting threads, ad slots and release archives remain placeholders.

The source flow is orchestration -> source-agent pipelines -> connectors ->
story processing. Pipelines compose connector operations; connectors do not
schedule themselves. `config\sources\` at the repository root describes onboarded
sources, not executable scraping logic. Connectors can be reused across communities.

## Backend shared code

| Folder under `shared\` | Responsibility |
| --- | --- |
| `configuration\` | Loading and validating backend configuration |
| `contracts\` | Internal module interfaces and shared backend data types |
| `storage\` | Persistence and evidence-file adapters |
| `model_inference\` | Local model runtime (`ollama.py`), newsworthiness ranking and story writing with fail-closed checks |
| `observability\` | Logging, metrics, and tracing instrumentation |

Keep business decisions in their owning modules, not in API routes or a generic
shared utility collection. Modules interact through explicit interfaces rather
than another module's internal implementation. Shared storage adapters do not
transfer ownership of a module's records to other modules.

Cross-project data contracts belong in the repository's `shared\contracts\`,
not here. Local health-view and telemetry configuration belongs in the repository's
`observability\`; instrumentation code belongs here.

SQLite and evidence files are initialized at startup. `shared\storage\database.py`
owns connection handling and the initial schema version; module-owned tables
must preserve explicit ownership as workflows are implemented.

The worker entry point is `modules\orchestration\worker.py`. It claims queued
per-location ingestion jobs, maintains heartbeats, and renews job leases.
Queue/recovery logic lives in `orchestration\jobs.py`; `orchestration\orchestrator.py`
queues one job per onboarded location and summarises status.

Locations (`modules\communities\`): `directory.py` indexes the IMLS public library
survey, `wikidata.py` resolves each system's official website, `venues.py` matches
feed venues to in-town branches, and `locations.py` stores onboarded profiles.
The source agent `source_connectors\agents\library_events.py` discovers a supported
feed on each website (robots.txt respected, HTTPS only); replaceable parsers live in
`source_connectors\connectors\` (`trumba_rss`, `ical`, `jsonld`). The pipeline
`source_connectors\pipelines\events.py` keeps next-7-day events at in-town branches
and stores them transactionally with job completion. No model is used.
For locations with a meeting platform, `source_connectors\agents\government_meetings.py`
(found at onboarding, overridable in `config\government-sources.json`) adds date-filtered
Legistar/CivicClerk agendas for the same window plus Legistar's recorded outcomes from the
past 7 days; `connectors\meetings.py` drops procedural and private items and prefixes a
plain-language sentence on what each public body does.
`email_previews\delivery.py` records one delivery per subscriber in `config\preview-subscribers.json`
when an edition publishes and sends via the loopback Mailpit sink; the `send_email_preview` job retries
only unsent addresses. Schema version 9 adds checked-prose caching, story withdrawals and a
latest-edition index; version 8 added local expansion interest signups; version 7 added
`email_deliveries`; version 6 added location snapshots and edition snapshot IDs.
Upgrades from versions 5-8 keep data. Upgrading from older versions
drops pre-location events, drafts and ingestion jobs. See the root README for retrieval scope
and limits.

The default authoring model is `qwen3:4b`. All sources compete on newsworthiness score;
full essential-news thresholds, a human-review workflow and ratified publication policy remain
operating decisions. Routine support events are not excluded just for covering a sensitive
topic; identifiable cases and allegations are held by conservative checks.
See the root README for setup, endpoints, configuration, and known limits.
