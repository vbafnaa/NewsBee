# Newsbee
CSE589 UW Entrepreneurship Prototyping

Stage 1 local prototype: FastAPI backend, ingestion worker, Astro reader site, review
console, SQLite, Mailpit, and Ollama. No Docker or cloud account needed.
Editions publish automatically after each ingestion; email is not implemented yet.

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
| Reader website (pick a location) | http://127.0.0.1:4321 |
| Health and review | http://127.0.0.1:8000/review |
| Ingested events | http://127.0.0.1:8000/review/ingestion |
| Edition audit (held items) | http://127.0.0.1:8000/review/editions |
| API docs | http://127.0.0.1:8000/docs |
| Mailpit | http://127.0.0.1:8025 |

Services bind to localhost only and have no authentication.

## Commands

Add a location once (any US city or town), then run the rest in a second terminal while
the stack is running:

```text
uv run --locked python scripts/dev.py setup-directory       # download US library directory
uv run --locked python scripts/dev.py find-location Seattle # list matching towns and ids
uv run --locked python scripts/dev.py onboard seattle-wa    # find library systems' websites
uv run --locked python scripts/dev.py ingest-events         # 7 days of events from tomorrow, all locations
uv run --locked python scripts/dev.py events                # list jobs and retained events
uv run --locked python scripts/dev.py author-edition <id>   # re-queue authoring for a location
uv run --locked python scripts/dev.py evaluate-model        # test a model on synthetic cases
```

Event feeds are found automatically on each library website (Trumba calendar, iCalendar,
BiblioCommons events, or schema.org events). Systems without a supported feed show as
`no_feed` on the health page. If a library's website can't be found, add it to
`config/library-websites.json` and re-run `onboard`.

Authoring needs `ollama pull qwen3:4b` first (`evaluate-model` tests the older blurb
prompt and needs `NEWSBEE_OLLAMA_MODEL` set). Models are never downloaded automatically.

Each ingestion stores a snapshot (event descriptions are kept locally) and queues
authoring:

1. **Deduplicate**: repeats of the same event become one story listing every date and branch.
2. **Rank**: the model scores each story for civic/practical value, broad appeal, and
   one-off specialness (weighted 3:2:1); rules break ties and stand in if ranking fails.
3. **Write**: top stories, at most one per category, up to 5, each get a headline and a
   short prose summary plus fixed When/Where and source link. Checks hold any text that
   adds facts not in the event, uses lists, or repeats itself; held items are left out and
   kept for audit at `/review/editions`.
4. **Front**: a headline about the top story, or "Auburn this week: Oct 19–25".
No human review step. Library data is for local evaluation only; do not commit or redistribute it.

## Configuration

Defaults need no setup. Optional environment variables:

| Variable | Default |
| --- | --- |
| `NEWSBEE_DATA_DIR` | `.local/data` |
| `NEWSBEE_OLLAMA_URL` | `http://127.0.0.1:11434` |
| `NEWSBEE_OLLAMA_MODEL` | unset (authoring uses `qwen3:4b`) |
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
