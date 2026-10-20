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

On **Runs & locations**, search for a town, select a suggestion and click **Add location**,
then **Start run**. Census and library directories are prepared automatically on first
use; that first search can take a minute. To publish a town on the reader site, select it
on **Output channel** and save. The reader search also finds imported towns without an
edition and lets readers register interest.

To remove an onboarded town, expand its card's **Location actions**, choose **Remove**
and confirm. Removal is blocked while a job is running. It clears the town's pipeline
records and manual links and removes it from output-channel directories.

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
defaults to `gemini` and rejects `ollama`. **Health** shows each provider's status; health
is failed when none can serve requests and warning when running on a fallback.
Hosted structured calls reserve at least 4,096 tokens for reasoning and output; story-length
limits and publication validation remain unchanged.

Ranking prefers the configured **hosted providers only**, in their listed order, whenever
any are configured; it does not silently spill the larger workload onto Ollama. No new API
key is needed if Gemini/Groq is already configured. Ollama-only configuration remains
available and uses the smaller candidate pool. Hosted APIs may impose rate limits or
charges; a free tier is not an unlimited quota.

## Test

```text
npm test            # vitest: connectors, ranking, authoring, model providers, orchestration (in-memory MongoDB; no real model or API calls)
npm run lint        # tsc --noEmit
```

## How a run works

One run per location; each step is a job in MongoDB `pipeline_jobs`, sized for one Vercel
function call, and `/api/pipeline/tick` (cron every minute) runs them.

1. **Collect**: one job per source (library, meetings, hazards, state news, trending).
   Rule-based preselection keeps up to **15 candidates per source** with hosted models
   configured (5 in Ollama-only mode); the combined pool is capped again at the same
   limit per connector type. With five types, at most 75 candidates reach hosted ranking,
   rather than 25. State feeds retain up to 25 geographically relevant items per newsroom,
   use the richest available RSS/Atom content and exclude announcements older than 14
   days or future-dated items. Older onboarded locations without a government profile
   get a real meeting-discovery task rather than silently skipping meetings.
   Failed sources are retried, then recorded without blocking the other sources.
2. **Author**: score candidates in batches of at most 12 with up to 600 characters of
   source context for hosted ranking (280 for Ollama). Retry missing/invalid ratings once,
   then report deterministic fallback scores explicitly. Ranking reports retain provider,
   model, pool size, attempts, errors and fallback counts. News candidates are authored
   before upcoming listings, preferring town news to wider news. Write one story per job,
   with validation and one retry; failures are held with reasons. The edition remains
   bounded at 9 items and at most 4 county/nearby items, not 75 authored stories.
3. **Publish**: the edition and email preview (saved, never sent) go to every enabled output
   channel that selects the location.

**Runs & locations** shows pipeline progress, published/held counts and **Inspect run**
for each source, story (with held reasons) and job. **Health** shows current providers,
scheduler and queue, plus 7/30-day charts filtered by location: completed/failed runs,
published/held stories, source outcomes and average run duration. History uses recorded
run data, not estimated provider uptime. Every step writes structured JSON logs.

Articles use short reported-style prose (up to 120 words), prefer dates/venues separately,
and receive complete-headline and unsupported-claim checks with one retry before holding.
Source-supported date context is allowed in event prose; mentioning the headline in a
summary is not itself a publication failure. Invented date words, unsupported factual
claims, repeated sentences, incomplete headlines, sensitive topics, unsafe source URLs
and geographic mismatches are still rejected. Presentation relaxations do not authorize
inventing missing context or dropping the sourced explanation required for trends.
Checks are rule-based safeguards, not a guarantee of factual entailment. Trend counts
measure attention, not its cause: a trend needs recent linked reporting explicitly
explaining the underlying story and attention; unexplained trends are omitted.

The published newsletter puts news articles first, followed by **Upcoming events**
(library events and public-meeting previews). Recorded meeting outcomes remain news.
The reader applies the same grouping to older editions without changing their stored copy,
and hides an empty upcoming section. New edition headlines lead with news when available;
an event can lead an event-only edition.

## Connectors & links

**Connectors & links** is the single place to inspect code-defined connectors, active
source queries, latest outcomes and discovered link caches, filtered by location. New
connectors and format support require a pipeline code change, not a portal action.

Select a location to add a manual link. Choose an existing connector, enter the link and
click **Validate & save link**. Library feeds/pages must use supported formats and the
location's onboarded library system; meetings use Legistar or CivicClerk tenant links;
state news uses RSS/Atom feeds. Editors are responsible for choosing official sources.
The existing connector must successfully query and parse a link before it is saved.
Unsupported links are rejected without saving.

Manual links supplement automatic discovery only for the selected town, retain normal
venue/geographic/editorial filtering, and persist until removed, including when there
are no current items or a later query fails. Wider-source settings also apply to manual
state-news links. **Forget discovered links** clears the automatic cache without
removing manual links. Legacy global source configuration is read-only through the portal.

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
overrides (`config/*.json`) are seeded into `source_configs`; location-specific additions
are validated and stored separately in `location_source_links`.
