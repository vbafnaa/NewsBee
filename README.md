# Newsbee
CSE589 UW Entrepreneurship Prototyping

## Stage 1: local prototype

The native prototype runs a FastAPI backend, a local ingestion worker,
an Astro reader website, a backend-rendered review/health console, and Mailpit.
SQLite stores local state; evidence stays in local files. Ollama is accessed
through a replaceable adapter. No Docker or cloud account is required.

**Not implemented yet:** general web scraping, edition generation, editorial/review
decisions, publication, and email composition. The worker executes only the
approved local library-event ingestion job. The site reports that no editions
exist. Health checks
report infrastructure availability, not editorial readiness.

## Local model evaluation (optional)

The initial evaluation candidate is `qwen3:1.7b` (about 1.4 GB of model files,
Apache 2.0 license). This is not a permanent model choice. Install Ollama from
https://ollama.com/download and start it locally; normal setup never downloads models.
In a separate terminal, run `ollama pull qwen3:1.7b`, then set
`NEWSBEE_OLLAMA_MODEL=qwen3:1.7b` for the evaluation command:

```powershell
# PowerShell
$env:NEWSBEE_OLLAMA_MODEL = "qwen3:1.7b"
uv run --locked python scripts/dev.py evaluate-model
```

```sh
# macOS / Linux
NEWSBEE_OLLAMA_MODEL=qwen3:1.7b uv run --locked python scripts/dev.py evaluate-model
```

To compare the larger candidate, explicitly download it with `ollama pull qwen3:4b`
(about 2.5 GB) and rerun the same command with `NEWSBEE_OLLAMA_MODEL=qwen3:4b`.
Both candidates must use the same fixture and validation-policy versions.

Evaluation uses five synthetic fixtures, not retained library records. It runs
sequentially on CPU with a 2,048-token context, a 512-token output limit, and
thinking disabled. Model responses are unloaded after each case; timings include
loading. Reports under `.local/data/model-evaluations/` contain drafts, field
checks, token counts, and durations. Failed checks exit nonzero; transport and
validation failures are logged and recorded. No drafts enter editorial storage
or publication.

**Strict fail-closed validation:** every copied field must match the supplied facts,
and the summary must exactly match a deterministic, labeled rendering of title,
date, source schedule, venue, and room when supplied. Values are quoted as data.
Any addition, omission, paraphrase, altered value, malformed response, or generation
failure is held; it is not replaced with a success-shaped fallback. Reports include
the expected summary and validation errors. The model receives the approved rendering:
this measures constrained copying, **not free-form writing ability**. A deterministic
renderer can produce these summaries without AI.

**Human review is still mandatory:** template matching cannot verify source truth,
resolve malicious source text, or authorize publication. Instruction-like titles
and venues remain quoted source data, never admission/accessibility assertions.
Model download
size is not RAM usage; successful execution on a larger machine does not certify
the CPU-only 8 GB baseline. Measure memory and latency on baseline hardware before
accepting the model. Model identity and license: [Ollama model](https://ollama.com/library/qwen3:1.7b),
[upstream license](https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE).

## Private draft edition preview

With Ollama running and `qwen3:1.7b` pulled, draft entries for retained Capitol Hill
events dated in the next 7 days (local machine date, inclusive):

```bash
uv run --locked python scripts/dev.py draft-edition
```

The command uses `qwen3:1.7b` unless `NEWSBEE_OLLAMA_MODEL` is set; the main stack
is unchanged. Each entry goes through the same strict fail-closed template gate as
evaluation. Validated entries are included; held entries are excluded and listed with
their errors. At most 50 events are drafted per run (overflow is reported). Inspect at
http://127.0.0.1:8000/review/editions; the health page shows the latest run. Drafts are
local only: not published or emailed, and every entry still needs human review.

## First source: Capitol Hill Branch events

The first connector reads the library's official
[branch-filtered RSS feed](https://www.trumba.com/calendars/kalendaro.rss?filterview=LocationCAP),
not AllEvents or library HTML pages. It covers **Capitol Hill Branch programming
only**, not all events in Capitol Hill, Seattle.

With the stack running, use a second terminal:

```text
uv run --locked python scripts/dev.py ingest-events
uv run --locked python scripts/dev.py events
```

The first command queues a manual run; the second prints the latest 20 ingestion
jobs and up to 200 retained event records. If the stack is stopped, queued jobs
wait until the worker starts. There is no scheduled polling. Enqueuing the same
source while a job is pending/running returns that job instead of creating another.
Use the health page for aggregate job counts; per-job errors, results, and duration
are available through the `events` command and logs.

**Local evaluation only; redistribution permission remains unresolved.** Retained
fields are title, source ID/link, source calendar date and schedule wording,
venue/room, and retrieval metadata. Descriptions and images are neither retained
nor published, and no model is invoked. The raw feed is processed in memory and
discarded; selective JSON evidence under `.local/data/evidence/spl-capitol-hill/`
includes a response hash, retrieval time, and the allowed facts only. Do not
commit real source data or use it as test fixtures.

Each event's venue link must explicitly identify the Capitol Hill Branch.
Other venues and explicitly identified library-wide closure notices without
venues are counted and skipped; other missing required fields fail the run.
Dates/times are not inferred: source schedule text is preserved rather than
guessing a timezone or end time. The feed's returned window is used as-is; this
is not a claim of complete weekly coverage. The same source ID and calendar date
update one record on replay; missing events are not automatically canceled or
deleted. Changes to an event's date may create another occurrence record.

HTTP/network failures and rate limits are retried at most three attempts, with
bounded backoff. Invalid feed data fails without retry. Jobs have renewable
90-second leases; after an interrupted worker's lease expires, a restarted worker
can reclaim the job, up to the same attempt limit. Publication stays disabled.

## Quick start

Install these prerequisites and make their commands available on your PATH:

| Tool | Requirement |
| --- | --- |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | Python dependency manager; automatically provisions Python 3.13 |
| [Node.js](https://nodejs.org/en/download) | 24 LTS, with npm 11 |
| [Mailpit](https://mailpit.axllent.org/docs/install/) | Native executable (`mailpit`); scaffold verified with 1.31.6 |
| [Ollama](https://ollama.com/download) | Native local inference runtime; start separately |

From the cloned repository root, on Windows, macOS, or Linux:

```text
uv run --locked python scripts/dev.py setup --browser
uv run --locked python scripts/dev.py up
```

The same commands work on all three operating systems. `--browser` installs
Playwright Chromium for browser tests; omit it for a smaller application-only
setup. Linux may also need browser system libraries: run
`uv run playwright install-deps chromium` if Playwright reports missing libraries
(this may require administrator privileges). Dependency and browser downloads
require internet access on first setup; fixture-based tests do not use live sources.

The launcher stays in the foreground and writes logs under `.local/logs/`.
Use Ctrl+C to stop its child processes, or run this from a second terminal:

```text
uv run --locked python scripts/dev.py stop
```

| Surface | Local URL |
| --- | --- |
| Reader website | http://127.0.0.1:4321 |
| Review and health page | http://127.0.0.1:8000/review |
| Read-only ingestion inspection | http://127.0.0.1:8000/review/ingestion |
| Private draft edition preview | http://127.0.0.1:8000/review/editions |
| API documentation | http://127.0.0.1:8000/docs |
| Mailpit inbox | http://127.0.0.1:8025 |
| Mailpit SMTP | `127.0.0.1:1025` |

The ingestion inspection page displays up to 200 retained events (ordered by
event date) and the latest 20 ingestion jobs, including outcomes and last-attempt
errors. Use **Refresh inspection** to reload current records. It is read-only:
it does not enqueue jobs, edit facts, generate stories, or publish content.
Source links and retrieval timestamps support manual verification; retained
records are local evaluation data, not a public edition.

All launched services bind to loopback. Do not expose them to a network; no
authentication or production hardening is implemented. Ports must be free;
the launcher fails rather than stopping other processes. It does not stop
an independently running Ollama instance.

### Local model

Start Ollama using its native app or `ollama serve`. **No model is selected or
downloaded automatically.** The target baseline is a CPU-only machine with 8 GB
RAM; a small quantized model still needs license, memory, speed, and quality
evaluation before selection. Tests use a fake model, not real inference.

The health page reports Ollama as unavailable when it cannot be reached, or
not configured when reachable without a selected model. This means overall
all-service health is intentionally degraded until a model is explicitly configured.
Ingestion readiness is shown separately and does not require Ollama or Mailpit.
Historical failures remain visible alongside the latest ingestion result; a past
failed run does not mean the current worker or latest run is failing.
Once approved and installed in Ollama, set `NEWSBEE_OLLAMA_MODEL` to its exact
installed name before starting the stack.

### Local configuration and data

Defaults work without configuration files. Optional environment variables:

| Variable | Default |
| --- | --- |
| `NEWSBEE_DATA_DIR` | `.local/data` under the repository root |
| `NEWSBEE_OLLAMA_URL` | `http://127.0.0.1:11434` (loopback HTTP only) |
| `NEWSBEE_OLLAMA_MODEL` | Unset |
| `NEWSBEE_MAILPIT_HOST` | `127.0.0.1` (loopback only) |
| `NEWSBEE_MAILPIT_SMTP_PORT` | `1025` |

Use your shell's environment-variable syntax; `.env` files are not automatically
loaded. The launcher uses fixed application/Mailpit ports. Mailpit defaults to an
ephemeral local inbox; restarting it clears previews. No outbound SMTP relay or
production email provider is configured.

Each developer has a separate ignored `.local/` directory containing the SQLite
database, evidence folder, logs, and launcher control files. Do not commit these.
If the launcher crashes and leaves `.local/stack.lock`, first verify its processes
have exited before removing that specific lock file. Do not remove the database
to resolve a lock issue.

## Development checks

```text
uv run --locked python scripts/dev.py test
uv run --locked python scripts/dev.py browser
uv run --locked ruff check .
npm --prefix projects/website run check
npm --prefix projects/website run build
```

Default tests use temporary SQLite databases, synthetic event XML, mocked HTTP
and Ollama responses, and SMTP fixtures. They cover filtering, fact-only retention,
replay deduplication, lease recovery, retries, and schema upgrades.
Browser tests start isolated local test servers and build the
website; they do not need Ollama or Mailpit. Real source ingestion and model
evaluation are explicit CLI commands, never part of default tests.

Python and npm dependency locks are committed for reproducible installation.
After intentionally changing shared Pydantic contracts, regenerate their JSON
schemas with `uv run --locked python scripts/dev.py contracts`.

## Repository map

```text
projects\
  backend\
    api\                    HTTP routes, schemas, and request-scoped wiring
      routes\
      schemas\
      dependencies\
    modules\                Pipeline and publishing capabilities
      orchestration\
      source_connectors\
        pipelines\          Source-agent fetch/extract/evidence workflows
        connectors\         Replaceable source-specific scraping logic
      story_processing\
      communities\
      editorial\
        planning\
        writing\
        publication_checks\
        review\
        edition_assembly\
        corrections\
      publishing\
      email_previews\
      ad_placements\
    shared\                 Backend contracts and infrastructure adapters
      configuration\
      contracts\            Backend-only interfaces and data types
      storage\
      model_inference\
      observability\        Instrumentation code
  website\                  Minimal local reader website
  review-console\           Minimal local editorial review interface
shared\
  contracts\                Data contracts exchanged between projects
config\
  local\                    Local environment configuration templates
  communities\              Community definitions
  sources\                  Onboarded-source definitions
  editorial_policies\       Versioned editorial policy configuration
observability\              Local health views and telemetry configuration
tests\
  unit\                     Isolated component tests
  integration\              Tests across component boundaries
  end_to_end\               Complete local workflow tests
  fixtures\                 Recorded and synthetic test inputs
scripts\                    Local setup, run, and maintenance commands
Docs\                       Existing product spec, roadmap, and diagrams
```

Start with the [backend map](projects/backend/README.md) for module ownership and
the [testing map](tests/README.md) for cross-component coverage. Empty directories
use `.gitkeep` placeholders so they survive a clone; these are not implementations.

## Design references

- [Product design spec](Docs/newsbee-design-spec-v1.html)
- [Implementation roadmap](Docs/newsbee-implementation-roadmap-v1.html)
