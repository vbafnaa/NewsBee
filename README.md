# Newsbee
CSE589 UW Entrepreneurship Prototyping

Stage 1 local prototype: FastAPI backend, ingestion worker, Astro reader site, review
console, SQLite, Mailpit, and Ollama. No Docker or cloud account needed.
Publishing and email are not implemented yet.

## Setup

Install [uv](https://docs.astral.sh/uv/getting-started/installation/),
[Node.js 24](https://nodejs.org/en/download),
[Mailpit](https://mailpit.axllent.org/docs/install/), and
[Ollama](https://ollama.com/download). Then, from the repo root:

```text
uv run --locked python scripts/dev.py setup --browser
uv run --locked python scripts/dev.py up
```

Stop with Ctrl+C or `uv run --locked python scripts/dev.py stop`. Logs go to `.local/logs/`.

| Surface | URL |
| --- | --- |
| Reader website | http://127.0.0.1:4321 |
| Health and review | http://127.0.0.1:8000/review |
| Ingested events | http://127.0.0.1:8000/review/ingestion |
| Draft edition | http://127.0.0.1:8000/review/editions |
| API docs | http://127.0.0.1:8000/docs |
| Mailpit | http://127.0.0.1:8025 |

Services bind to localhost only and have no authentication.

## Commands

Run each command in a second terminal while the stack is running:

```text
uv run --locked python scripts/dev.py ingest-events    # fetch Capitol Hill Branch library events
uv run --locked python scripts/dev.py events           # list jobs and retained events
uv run --locked python scripts/dev.py draft-edition    # draft next 7 days' edition (needs Ollama)
uv run --locked python scripts/dev.py evaluate-model   # test a model on synthetic cases
```

The model commands need `ollama pull qwen3:1.7b` first. `evaluate-model` also needs
`NEWSBEE_OLLAMA_MODEL=qwen3:1.7b`. Models are never downloaded automatically.

Drafts are model-written headlines and blurbs. Rule-based checks (`news_blurb_v1`) hold
any text that adds numbers, times, names, links, or claims (such as price or booking)
not in the event facts. Checks cannot prove text is true, so every draft needs human
review. Library data is for local evaluation only; do not commit or redistribute it.

## Configuration

Defaults need no setup. Optional environment variables:

| Variable | Default |
| --- | --- |
| `NEWSBEE_DATA_DIR` | `.local/data` |
| `NEWSBEE_OLLAMA_URL` | `http://127.0.0.1:11434` |
| `NEWSBEE_OLLAMA_MODEL` | unset (`draft-edition` uses `qwen3:1.7b`) |
| `NEWSBEE_MAILPIT_HOST` | `127.0.0.1` |
| `NEWSBEE_MAILPIT_SMTP_PORT` | `1025` |

## Development checks

```text
uv run --locked python scripts/dev.py test
uv run --locked python scripts/dev.py browser
uv run --locked ruff check .
```

Tests use fixtures and mocks only (no live sources or models). After changing
`shared/contracts`, run `uv run --locked python scripts/dev.py contracts`.

## Repository map

```text
projects\backend\         API, pipeline modules, shared adapters
projects\website\         Minimal reader site
projects\review-console\  Minimal review and health pages
shared\contracts\         Contracts shared between projects
config\                   Communities, sources, editorial policies
tests\                    unit, integration, end_to_end, fixtures
scripts\dev.py            Setup, run, and maintenance commands
Docs\                     Product spec and roadmap
```

See the [backend map](projects/backend/README.md), [testing map](tests/README.md),
[design spec](Docs/newsbee-design-spec-v1.html), and
[roadmap](Docs/newsbee-implementation-roadmap-v1.html).
