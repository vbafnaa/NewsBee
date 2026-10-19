# Newsbee
CSE589 UW Entrepreneurship Prototyping

Local Stage 1 prototype of an auto-published community newspaper. Sources are library events
and local government meetings; editions publish after each ingestion with no human review.

```mermaid
flowchart LR
  Locations[Onboarded locations] --> Library[Library events connector]
  Locations --> Meetings[Government meetings connector]
  Library --> Ingest[Ingestion]
  Meetings --> Ingest
  Ingest --> Snapshot[Event snapshots]
  Snapshot --> Rank[Newsworthiness ranking]
  Rank --> Write[Story writing and checks]
  Write --> Site[Reader website]
  Write --> Console[Health and audit console]
  Write --> Email[Email preview]
  Email --> Site
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

| Page | URL |
| --- | --- |
| Reader website | http://127.0.0.1:4321 |
| Health and review | http://127.0.0.1:8000/review |
| API docs | http://127.0.0.1:8000/docs |
| Email previews (Mailpit) | http://127.0.0.1:8025 |

Localhost only, no authentication. Logs go to `.local/logs/`.

## Commands

In a second terminal (prefix each with `uv run --locked python scripts/dev.py`):

| Command | Does |
| --- | --- |
| `setup-directory` | Download the US library directory (once) |
| `find-location Edmonds` | List matching towns and ids |
| `onboard edmonds-wa` | Add a location and find its library websites and meeting platform |
| `remove-location <id>` | Delete a location and all its data |
| `ingest-events` | Pull 7 days of events and meeting agendas from tomorrow, plus the past 7 days' recorded meeting decisions, then author editions |
| `author-edition <id>` | Re-author one location |
| `events` | List jobs and stored events |

If a library website isn't found, add it to `config/library-websites.json` and re-run
`onboard`. Library data is for local evaluation only; don't commit or redistribute it.

Government meetings come from the town's Legistar or CivicClerk public API, found via the
town website (Wikidata) or its name. If `onboard` reports no platform, add
`{"<location id>": {"platform": "legistar", "tenant": "<name>"}}` to
`config/government-sources.json` and re-run `onboard`. Each meeting story opens with what
the public body does; procedural items (roll call, minutes) and private individuals' cases
are left out. Outcomes are the clerk's recorded actions; CivicClerk records none, so it
supplies agendas only.

## Authoring

1. **Deduplicate** repeated events into one story.
2. **Rank** in two steps. Each source type shortlists its own top 5 (from at most 10 randomly
   sampled) by its own rules: library events put one-off events, then practical help, first;
   meetings put the city council first, then sooner meetings and fuller agendas. The model then
   ranks the shortlists together (civic 3 : appeal 2 : one-off 1).
3. **Write** up to 5 stories, one per category. Drafts that add facts, repeat
   themselves, stop mid-sentence, drift into non-Latin characters or leave the event's own
   name out of the headline get one retry, then are held for audit at `/review/editions`.
4. **Front** headline naming the top story (same checks and one retry, else a fixed fallback).
5. **Email** a preview (headline, intro, a teaser blurb and a link to the website) to the
   test subscribers for that location in `config/preview-subscribers.json`. Failed sends
   retry and show on the health page.

## Development

```text
uv run --locked python scripts/dev.py test      # fixtures and mocks only
uv run --locked python scripts/dev.py browser
uv run --locked ruff check .
```

Run `scripts/dev.py contracts` after changing `shared/contracts`. Optional settings
(`NEWSBEE_DATA_DIR`, `NEWSBEE_OLLAMA_URL`, `NEWSBEE_OLLAMA_MODEL`, ...) all have defaults.

| Folder | Holds |
| --- | --- |
| `projects/backend` | API, pipeline modules, shared adapters ([map](projects/backend/README.md)) |
| `projects/website` | Minimal reader site |
| `projects/review-console` | Minimal review and health pages |
| `shared/contracts` | Contracts shared between projects |
| `config` | Library website and government platform overrides, preview subscribers, policies |
| `tests` | Unit, integration, end-to-end ([map](tests/README.md)) |
| `Docs` | [Design spec](Docs/newsbee-design-spec-v1.html), [roadmap](Docs/newsbee-implementation-roadmap-v1.html) |
