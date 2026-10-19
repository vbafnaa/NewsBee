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
| `editorial\planning\` | Selecting candidates and planning an edition |
| `editorial\writing\` | Producing full stories with source attribution |
| `editorial\publication_checks\` | Evidence and policy checks with explicit publication outcomes |
| `editorial\review\` | Human-review exceptions and recorded decisions |
| `editorial\edition_assembly\` | Assembling approved stories and separate labeled ad slots |
| `editorial\corrections\` | Correction workflow and history |
| `publishing\` | Local releases, published stories, editions, and archives |
| `email_previews\` | Email previews derived from published editions and delivered only to a local mail sink |
| `ad_placements\` | Separate ad-slot data and placement boundaries, not advertiser intake or payments |

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
| `model_inference\` | Replaceable local model-runtime adapters |
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

The worker entry point is `modules\orchestration\worker.py`. It claims the manually
queued library RSS ingestion jobs, maintains heartbeats while ingestion runs,
and renews job leases. Queue/recovery logic lives in `orchestration\jobs.py`.
The source pipeline is `source_connectors\pipelines\events.py`; the replaceable
RSS parser is `source_connectors\connectors\spl_rss.py`. No model is used.
Database schema version 2 migrates version 1 without deleting existing records.
Source events are upserted transactionally with job completion; selective JSON
evidence is stored locally. See the root README for retrieval scope and limits.

No essential-news thresholds, review policy, or model are defined by this scaffold.
See the root README for setup, endpoints, configuration, and known limits.
