# Journalist site (Stage 2)

Next.js admin console plus the TypeScript port of the Stage 1 pipeline (`pipeline/`). It
runs locally with stand-ins, or on Vercel with MongoDB Atlas, Google Drive and Gemini.

## Run locally

From this directory, with Node 24 and [Ollama](https://ollama.com/download)
(`ollama pull qwen3:4b`) running:

```text
npm install
(cd ../reader-site && npm install)
npm run local
```

`npm run local` starts a local MongoDB (data in `.local/stage2/mongo`), this site on
http://127.0.0.1:3000, the reader site on http://127.0.0.1:4321, and a pipeline tick every
5 s in place of Vercel Cron. Drive is a local folder (`.local/stage2/drive`). Google sign-in
is skipped on localhost.

On the dashboard: **Import Census places and libraries** (once), search a town, **Onboard**,
then **Run**. To publish a town on the reader site, tick it on **Output channel** and save.

## Model providers

Local runs use Ollama by default. To call hosted LLM APIs instead (locally or in the cloud),
list providers in fallback order in `NEWSBEE_MODEL_PROVIDERS`; if a call fails with a
provider or network error, the same call is retried on the next provider.

| Provider | Variables |
| --- | --- |
| `gemini` | `NEWSBEE_GEMINI_API_KEY`, `NEWSBEE_GEMINI_MODEL` (default `gemini-flash-latest`) |
| `ollama` (local only) | `NEWSBEE_OLLAMA_URL`, `NEWSBEE_OLLAMA_MODEL` (default `qwen3:4b`) |
| Any other name, e.g. `openai`, `groq`, `azure`: an OpenAI-compatible API | `NEWSBEE_LLM_<NAME>_BASE_URL` (default for `openai`: `https://api.openai.com/v1`), `_MODEL`, `_API_KEY`; optional `_AUTH_HEADER` (`api-key` for Azure), `_MAX_TOKENS_PARAM` (`max_completion_tokens` for newer OpenAI models), `_JSON_MODE` (`json_object` if the API lacks JSON schema output) |

Example: `NEWSBEE_MODEL_PROVIDERS=gemini,openai`, `NEWSBEE_GEMINI_API_KEY=...`,
`NEWSBEE_LLM_OPENAI_MODEL=gpt-4.1-mini`, `NEWSBEE_LLM_OPENAI_API_KEY=...`. Cloud mode
defaults to `gemini` and rejects `ollama`. The dashboard shows each provider's status; health
is failed when none can serve requests and warning when running on a fallback.
Hosted structured calls reserve at least 4,096 tokens for reasoning and output; story-length
limits and publication validation remain unchanged.

## Test

```text
npm test            # vitest: connectors, ranking, authoring, model providers, orchestration (in-memory MongoDB; no real model or API calls)
npm run lint        # tsc --noEmit
```

## How a run works

One run per location; each step is a job in MongoDB `pipeline_jobs`, sized for one Vercel
function call, and `/api/pipeline/tick` (cron every minute) runs them.

1. **Collect**: one job per source (library, meetings, hazards, state news, trending). Each
   source keeps its own top 5 stories. Failed sources are retried, then recorded; the run
   continues.
2. **Author**: after every source finishes, stories are ranked across sources and written one
   per job by the model. Each story gets all validation checks and one retry; failures are
   held with their reasons.
3. **Publish**: the edition and email preview (saved, never sent) go to every enabled output
   channel that selects the location.

The dashboard shows per-location health (stage, sources ok/failed, published/held, model
errors, scheduler and queue). **Details** shows each source, story (with held reasons) and
job. Every step also writes structured JSON logs.

## Cloud configuration (Vercel)

| Variable | Purpose |
| --- | --- |
| `NEWSBEE_MODE=cloud` | Use Drive and require Google sign-in |
| `MONGODB_URI`, `MONGODB_DATABASE` | MongoDB Atlas |
| `NEWSBEE_MODEL_PROVIDERS` plus each provider's variables (see Model providers) | LLM APIs, in fallback order |
| `GOOGLE_SERVICE_ACCOUNT_JSON` (or `_EMAIL` and `_PRIVATE_KEY`) | Drive writer (Editor on the folders below) |
| `NEWSBEE_PIPELINE_DRIVE_FOLDER_ID` | Drive folder for run artifacts and new channel folders |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` | Google sign-in (redirect URI `https://<host>/api/auth/callback/google`) |
| `CRON_SECRET` | Authorizes the Vercel Cron call to `/api/pipeline/tick` |
| `NEWSBEE_AI_LINK_DISCOVERY` (optional) | Also let the model look for event links (off by default) |
| `NEWSBEE_READER_SITE_URL` (optional) | URL of the default `reader-site` channel |

`vercel.json` schedules the tick every minute, which needs a Vercel Pro plan.

Admins are documents `{ "email": "editor@example.com", "enabled": true }` in
`journalist_admins` (lowercase); the **Administrators** page adds more. Reviewed source
overrides (`config/*.json`) are seeded into `source_configs` and edited on **Sources**.
