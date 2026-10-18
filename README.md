# Newsbee
CSE589 UW Entrepreneurship Prototyping

## Stage 1: local prototype

The native infrastructure scaffold runs a FastAPI backend, a heartbeat worker,
an Astro reader website, a backend-rendered review/health console, and Mailpit.
SQLite stores local state; evidence stays in local files. Ollama is accessed
through a replaceable adapter. No Docker or cloud account is required.

**Not implemented yet:** scraping, edition generation, editorial/review decisions,
publication, and email composition. The worker records heartbeats but does not
execute jobs. The site explicitly reports that no editions exist. Health checks
report infrastructure availability, not editorial readiness.

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
| API documentation | http://127.0.0.1:8000/docs |
| Mailpit inbox | http://127.0.0.1:8025 |
| Mailpit SMTP | `127.0.0.1:1025` |

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
health is intentionally degraded until a model is explicitly configured.
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

Default tests use temporary SQLite databases, mocked Ollama responses, and
SMTP fixtures. Browser tests start isolated local test servers and build the
website; they do not need Ollama or Mailpit. Real source/model evaluations are
not implemented and must be explicitly invoked when added.

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
