# Newsbee
CSE589 UW Entrepreneurship Prototyping

Newsbee is a local Stage 1 prototype of an automatically written weekly community newspaper.
For each onboarded town it:

1. pulls the coming week's library events and local government meetings,
2. ranks them and has a local model (Ollama, `qwen3:4b`) write short stories,
3. holds any story that fails its checks, and publishes the rest to a reader website,
4. emails a preview to test subscribers (captured locally by Mailpit).

```mermaid
flowchart LR
  Library[Library events] --> Ingest[Ingestion]
  Meetings[Government meetings] --> Ingest
  Ingest --> Rank[Ranking] --> Write[Story writing and checks]
  Write --> Site[Reader website]
  Write --> Email[Email preview]
  Write --> Console[Health and review console]
```

## Setup

Install [uv](https://docs.astral.sh/uv/getting-started/installation/),
[Node.js 24](https://nodejs.org/en/download),
[Mailpit](https://mailpit.axllent.org/docs/install/) and
[Ollama](https://ollama.com/download), then:

```text
ollama pull qwen3:4b
uv run --locked python scripts/dev.py setup --browser
uv run --locked python scripts/dev.py up
```

In a second terminal, add a town and publish its first edition:

```text
uv run --locked python scripts/dev.py setup-directory
uv run --locked python scripts/dev.py onboard edmonds-wa
uv run --locked python scripts/dev.py ingest-events
```

| Page | URL |
| --- | --- |
| Reader website | http://127.0.0.1:4321 |
| Health dashboard and review | http://127.0.0.1:8000/review |
| API docs | http://127.0.0.1:8000/docs |
| Email previews (Mailpit) | http://127.0.0.1:8025 |

Logs go to `.local/logs/`. Everything runs on localhost with no authentication.

## Commands

Prefix each with `uv run --locked python scripts/dev.py`:

| Command | Does |
| --- | --- |
| `find-location Edmonds` | Find a town's id |
| `onboard <id>` / `remove-location <id>` | Add or remove a town |
| `ingest-events` | Fetch sources and publish editions for every town |
| `author-edition <id>` | Re-write one town's edition |
| `withdraw-story <edition id> --story <story id> --reason "..."` | Remove a published story with a correction |
| `events` | List jobs and stored events |

If `onboard` can't find a town's library website or meeting platform, add it to
`config/library-websites.json` or `config/government-sources.json` and re-run it.

## Development

```text
uv run --locked python scripts/dev.py test      # offline tests
uv run --locked python scripts/dev.py browser   # browser tests
uv run --locked python scripts/dev.py replay    # Stage 1 replay check
uv run --locked ruff check .
```

| Folder | Holds |
| --- | --- |
| `projects/backend` | API, pipeline modules, shared adapters ([map](projects/backend/README.md)) |
| `projects/website` | Reader site |
| `projects/review-console` | Health and review pages |
| `shared/contracts` | Contracts shared between projects |
| `config` | Source overrides, preview subscribers, policies |
| `tests` | Unit, integration, end-to-end ([map](tests/README.md)) |
| `Docs` | [Design spec](Docs/newsbee-design-spec-v1.html), [roadmap](Docs/newsbee-implementation-roadmap-v1.html) |