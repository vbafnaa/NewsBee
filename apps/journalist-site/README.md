# Journalist site and cloud pipeline

Next.js admin console plus the TypeScript port of the Stage 1 pipeline (`pipeline/`). It
runs locally with stand-ins, or on Vercel with MongoDB Atlas, Google Drive and Gemini.

## Run locally

From this directory, with Node 24 and [Ollama](https://ollama.com/download)
(`ollama pull qwen3:4b`) running:

```text
npm ci
npm --prefix ../reader-site ci
npm run local
```

`npm run local` starts a local MongoDB (data in `.local/stage2/mongo`), this site on
http://127.0.0.1:3000, the reader site on http://127.0.0.1:4321/reader, and a pipeline tick every
5 s as a recovery aid. Drive is a local folder (`.local/stage2/drive`). Google sign-in
is skipped on localhost.

On **Runs & locations**, search for a town, select a suggestion and click **Add location**,
then **Start pipeline (collection)**. When collection finishes, click **Start authoring**;
when stories finish, click **Write front page and email, then publish**. Each click starts
and chains that stage's jobs immediately, without cron. The local poller never crosses
these editor gates. Census and library directories are prepared automatically on first
use; that first search can take a minute. New towns are enabled for reader publishing
automatically; adjust them in **Publishing settings** on **Runs & locations**.
The reader search also finds imported towns without an
edition and lets readers register interest.

**Run orchestration** shows recent attempts with their stages, stories and expandable per-job
logs (including source outcomes and errors). **Cancel run** stops queued jobs and marks a
collecting, authoring, finishing or editor-waiting attempt cancelled; a job already executing may finish before its
cancellation is reflected in the log. Once publication begins, cancellation is unavailable
to avoid partially published editions. **Restart run** creates a fresh attempt for a
published, failed or cancelled run;
the earlier attempt remains in history. Cancel a waiting attempt before restarting it.
**Resume** re-kicks an in-progress stage without creating duplicate jobs or resetting
its timeout/backoff. Only one run per location can be open (including editor-waiting) at a time.
When upgrading from the collecting-only index, startup reconciles legacy overlapping
attempts before installing the active-run index. The furthest-progressed attempt is kept;
the others retain their own run IDs and history as cancelled, with queued jobs stopped and
a superseded-by reason. Publication already in progress is never interrupted.

## Neighborhood and community coverage

Enter a US neighborhood/community and its city/state, then press **Search all communities**
or Enter. Photon/OpenStreetMap resolves places beyond any checked-in catalog, for example
`Wallingford, Seattle, Washington`. Select the matching result and add it. Results depend
on the provider's mapped places and spelling: no geographic directory guarantees every
informal community. Typing alone searches the local Census directory, optional reviewed
overrides and previously resolved places; it never sends autocomplete requests upstream.
`Freemont` remains an alias for the optional Fremont override.

Each provider place has a stable OSM-based ID, separate run history, source settings,
link cache, output selection and reader interest signup. Onboarding reads the saved
provider record, not client-supplied coordinates. Existing Census city editions and IDs
are unchanged. Reader search includes saved provider communities without making public
geocoder requests. No catalog entry or matching Census parent row is required.

**Location resolved is not sources ready.** Source discovery runs independently; missing
branches, websites, supported government platforms and community feeds are visible gaps,
not a reason to reject a valid place. Location cards and **Sources** report `ready`,
`partial` or `no_local_sources`. These statuses describe configuration availability, not
a guarantee of fresh content; run inspection still reports actual connector outcomes.
Validated manual links are included when evaluating readiness.

Use a provider polygon when present. Standard Photon results often contain only a center
or extent; an extent is explicitly an **approximate bounding box**, and a point-only
result uses an **approximate 2 km radius**, never a claimed neighborhood boundary.
IMLS library outlet coordinates select candidate branches within that area. Approximate
selection can include nearby branches; review the selected branch names before publication.
Outlets without coordinates are not silently selected from the whole parent city.

| Connector | Community behavior |
| --- | --- |
| Library | Reuse system calendars, retaining events only at spatially selected branches (or optional reviewed branch overrides). Missing configured branches produce a gap, never a citywide fallback. Existing IMLS imports are upgraded once to include outlet coordinates. |
| Government | Discover the governing city/county supplied by the provider, honoring community then parent overrides. Missing jurisdiction stays unresolved. Filter agenda **items before summarization**, not the council meeting venue, by community mention, selected-venue address or available geographic evidence. Manual meeting links use the same filter. |
| Community/state news (`statenews`) | Reuse the news connector. Validate actual RSS/Atom links from the community website supplied by OSM or exact-name, nearby-US Wikidata discovery, plus reviewed overrides. Retain only items with community relevance evidence; parent-city/county mentions alone are insufficient. This is not general web crawling or arbitrary HTML-news extraction. |
| Trends | Automatically search community names, aliases, coverage terms and selected library branches, qualified by the parent jurisdiction; also read the community's discovered RSS/Atom feeds. Keep only recent articles with community evidence, independently of Wikipedia traffic. Popularity or parent/nearby city mentions alone do not qualify. |
| Hazards | Keep regional USGS coverage centered on the neighborhood, labeled as nearby earthquakes rather than neighborhood reporting. |

The **Sources** location filter shows coverage terms, selected branches, feed configuration,
area uncertainty and discovery gaps. Additional validated
publisher RSS/Atom feeds can be added with the **Community and state newsrooms** connector.
All normal date, safety and editorial checks still apply. Broad citywide policy changes
without community/venue/geographic evidence are intentionally omitted. Retained candidate
facts record the evidence method and matches. RSS/Atom items can supply validated
GeoRSS/WGS84 point coordinates; an item's coordinates are not inferred from a publisher
office or a council meeting venue. Generic names such as "Downtown" need a parent
jurisdiction mention or stronger venue/geographic evidence. Editors should select coverage terms
carefully to balance missed stories against false positives.

Community reporting requires no per-location topic catalog or model-generated search terms.
It derives up to six Bluesky searches from each saved onboarding profile (up to four
distinct community/coverage names and two selected branch names), using the parent
city/county instead of a state-only qualifier. A place without a distinct parent uses its
state. It also reads up to three unique community feeds already validated during onboarding.
Candidate links are interleaved across searches and feeds, deduplicated and limited to
12 article URLs per collection. Articles still need a publisher, publication date within
seven days and substantive local text; feed titles, social posts and a publisher's office
location are not geographic evidence. Each retained community story records the matching
community/alias/selected-venue evidence. Practical impact and freshness precede attention
in ranking, with publisher diversity in the five retained community-reporting candidates.
Repeated articles discovered by newsroom, Bluesky and Wikipedia collection collapse by
article URL and publication day.

Wikipedia remains a separate, optional attention-discovery path. For communities it resolves
real article titles through parent-qualified Wikipedia search and checks the result's
introductory text for community and parent relevance, rather than inventing municipal
article names or inheriting the parent city's sports/landmark watchlist. Existing pageview
spike thresholds apply only to that path; no Wikipedia page or traffic spike is needed for
community-feed or Bluesky-linked reporting. Town discovery retains its 15-mile configured
nearby-place coverage. Search queries, feed URLs and partial discovery errors are recorded
on the community-reporting source result; failures of every discovery source are reported
as failures, not empty successful collections. Changes to profile terms, venues or feeds
invalidate the daily Wikipedia cache identity.

Optional reviewed overrides live in `config/communities.json` and are seeded once into the
`communities` document in MongoDB `source_configs`. They enrich matching provider places
and retain legacy catalog IDs; they do not gate discovery. Entries specify an ID ending in the parent's
Census ID, a display name, state code/name, parent city, center coordinates, search aliases,
coverage terms, exact library branch selections (name normalization is supported), and
reviewed HTTPS RSS/Atom feeds. Use the official
[Seattle Public Library branch directory](https://www.spl.org/hours-and-locations) to review
branch selections; the current local feeds are
[My Ballard](https://www.myballard.com/feed/) and
[West Seattle Blog](https://westseattleblog.com/feed/).

To discover another community, use the search UI; **do not add a catalog entry**.
To maintain reviewed overrides, update MongoDB as well if it was already seeded.
Changing a checked-in seed never overwrites live configuration. Re-onboard affected communities to refresh their saved
coverage/branch/feed snapshot; manually managed library websites and government settings
are preserved. Reader search reads the same directory, so communities can collect interest
before their first edition. Census re-imports do not erase saved provider identities.

### Geographic provider operations

`NEWSBEE_GEOCODER_URL` selects an HTTPS Photon-compatible API (default
`https://photon.komoot.io/api/`). Explicit searches are cached in MongoDB for seven days
(empty results: one hour); a shared Mongo lease serializes upstream requests across
instances with at least a 1.1-second cooldown. Provider errors are surfaced, not cached
as successful empty searches. Results are US-only settlement/district features;
businesses, parks and other POIs are excluded. Responses are size/time bounded.
The UI attributes OpenStreetMap contributors; stored records retain attribution.

Cache entries expire automatically; resolved place identities remain available for saved
locations and reader interest. Provider-backed onboarding does not require a Census
import; a failed library reference download is reported as a source gap.

The public Photon demo has fair-use limits and no availability guarantee. For production
traffic, configure a hosted or self-managed Photon endpoint and follow its usage policy.
OSM coverage, jurisdiction metadata, boundaries and publisher websites vary; missing
sources require editorial configuration, not broader citywide scraping. Feed discovery
uses the existing public-HTTPS/robots/DNS/redirect protections and validates feed format.

To remove an onboarded community or town, expand its card's **Location actions**, choose **Remove**
and confirm. Removal is blocked while a job is running. It clears the town's pipeline
records and manual links and removes it from output-channel directories.

### Publishing settings

Expand **Publishing settings** in **Runs & locations** to manage the main reader site:
edit its URL, enable or disable publishing, and turn individual locations off.
Newly onboarded locations are enabled for the default reader site automatically.
Re-onboarding an existing location preserves any publishing disablement. Existing
location selections are not changed automatically. Saving settings
copies the latest published edition for re-enabled towns (if available) and refreshes
the reader's location directory. Unselected towns leave the directory; their stored
edition files are not deleted. Towns without a published edition do not appear yet.

The console no longer has a separate output-channel page, channel picker, or
channel-creation form. Old `/output-channel` bookmarks redirect to these settings.
The underlying output-channel API, storage folders, and multi-channel pipeline remain
unchanged; the simplified UI manages the default `reader-site` channel.

## Model providers

Local runs use Ollama by default. To call hosted LLM APIs instead (locally or in the cloud),
list providers in fallback order in `NEWSBEE_MODEL_PROVIDERS`; if a call fails with a
provider or network error, the same call is retried on the next provider.

| Provider | Variables |
| --- | --- |
| `gemini` | `NEWSBEE_GEMINI_API_KEY`, `NEWSBEE_GEMINI_MODEL` (default `gemini-flash-latest`) |
| `ollama` (local only) | `NEWSBEE_OLLAMA_URL`, `NEWSBEE_OLLAMA_MODEL` (default `qwen3:4b`) |
| Any other name, e.g. `openai`, `groq`, `azure`: an OpenAI-compatible API | `NEWSBEE_LLM_<NAME>_BASE_URL` (default for `openai`: `https://api.openai.com/v1`), `_MODEL`, `_API_KEY`; optional `_AUTH_HEADER` (`api-key` for Azure), `_MAX_TOKENS_PARAM` (`max_completion_tokens` for newer OpenAI models), `_TEMPERATURE` (default `0`; `default` omits it). If a model rejects either one, the adapter switches to `max_completion_tokens` or omits `temperature` and retries automatically, `_JSON_MODE` (`json_object` if the API lacks JSON schema output) |

Example: `NEWSBEE_MODEL_PROVIDERS=gemini,openai`, `NEWSBEE_GEMINI_API_KEY=...`,
`NEWSBEE_LLM_OPENAI_MODEL=gpt-4.1-mini`, `NEWSBEE_LLM_OPENAI_API_KEY=...`. Cloud mode
defaults to `gemini` and rejects `ollama`. **Health** shows each provider's status; health
is failed when none can serve requests and warning when running on a fallback.
Every provider call is recorded (35-day retention); **Health** shows calls, tokens, 429s
and estimated cost. Optionally set `NEWSBEE_MODEL_<NAME>_INPUT_COST_PER_MTOK`,
`_OUTPUT_COST_PER_MTOK` (USD per million tokens), `_RPM_LIMIT` and `_RPD_LIMIT` to see
cost and limit warnings (e.g. `NEWSBEE_MODEL_GEMINI_RPM_LIMIT=15`).
Hosted structured calls reserve at least 4,096 tokens for reasoning and output; story-length
limits and publication validation remain unchanged.

Ranking prefers the configured **hosted providers only**, in their listed order, whenever
any are configured; it does not silently spill the workload onto Ollama. No new API
key is needed if Gemini/Groq is already configured. Ollama-only configuration remains
available with the same five-candidate limit. Hosted APIs may impose rate limits or
charges; a free tier is not an unlimited quota.

## Test

```text
npm test            # vitest: connectors, ranking, authoring, model providers, orchestration (in-memory MongoDB; no real model or API calls)
npm run lint        # tsc --noEmit
```

Opt-in live neighborhood smoke (Ollama running with `qwen3:4b` installed):

```powershell
$env:NEWSBEE_TEST_OLLAMA = "1"
npm test -- pipeline/tests/communities/ollama.integration.test.ts --maxWorkers=1
```

This searches uncataloged Wallingford through live Photon, adds and validates the live
Wallyhood RSS feed, and runs the real news connector, ranking, authoring and local
publication with **Ollama only**, explicitly advancing both editor gates. Automatic
sources are disabled to bound the smoke to that feed. Missing reference-library
branches remain a visible gap; this is not a full live library/government crawl.
Artifacts and `smoke-result.json` persist under `.local/community-smoke`
(override with `NEWSBEE_SMOKE_ROOT`); the isolated test MongoDB is temporary.

## How a run works

One run per location, with three manually triggered stages; each step is a job in MongoDB
`pipeline_jobs`, sized for one Vercel function call. Cloud admin triggers publish a wake-up
to Vercel Queues; its private `/api/pipeline/queue` consumer executes one job and publishes
the next within the current stage. Retries and worker-lease waits use delayed deliveries;
editor gates never start automatically. No self-HTTP calls or `CRON_SECRET` are needed for
portal-started cloud stages. The deployed Vercel cron remains disabled. Locally, admin
triggers use `/api/pipeline/advance` with short-lived tokens signed with `AUTH_SECRET`,
and `npm run local` supplies that secret automatically. Configure it yourself when using
`npm run dev` directly.

Locations execute **sequentially**, including across overlapping local ticks, queue deliveries
and manual triggers. A renewable MongoDB worker lease prevents parallel model requests
from different scheduler calls. The oldest run with pending/running jobs in its
in-progress stage finishes that stage (or fails) before the next location starts; a run
waiting for backoff keeps later locations queued. A run waiting for an editor holds no
worker lease and does not block another location.
Each job executes in its own invocation in local and cloud mode, preserving the separate
Vercel function boundary without bypassing serialization or backoff. Optional ticks can
also recover interrupted work, but never cross a gate.

1. **Start pipeline (collection)**, per location or all locations: one job per source
   (library, meetings, hazards, state news, trending, and the parent-and-homeowner sources:
   city calendar, drinking water, housing permits, development permits and school athletics).
   Rule-based preselection keeps up to **5 candidates per source** in hosted and local
   modes; the combined pool is capped again at five per connector type. With ten types, at
   most **50 candidates per location** reach model ranking. State feeds still retain up
   to 25 geographically relevant items per newsroom before preselection,
   use the richest available RSS/Atom content and exclude announcements older than 14
   days or future-dated items. Older onboarded locations without a government profile
   get a real meeting-discovery task rather than silently skipping meetings.
   Failed sources are retried, then recorded without blocking the other sources.
   The run stops at `awaiting_authoring`; no ranking or writing starts automatically.
2. **Start authoring**: score candidates in batches of at most 12 with up to 600 characters of
   source context for hosted ranking (280 for Ollama). Retry missing/invalid ratings once,
   then report deterministic fallback scores explicitly. Ranking reports retain provider,
   model, pool size, attempts, errors and fallback counts. News candidates are authored
   before upcoming listings, preferring town news to wider news. Write one story per job,
   with validation and one retry; failures are held with reasons. The edition remains
   bounded at 9 items and at most 4 county/nearby items, not 25 authored stories.
   The run stops at `awaiting_finish`; front-page/email writing and publication wait.
3. **Write front page and email, then publish**: write the edition front page and email
   preview, save the artifacts, and publish the edition to every enabled output channel
   that selects the location. Email is preview-only: **no email is sent**.

The run list/detail and Health show both waiting states. Authenticated same-origin admin
POSTs to `/api/admin/runs/<run-id>/authoring`, `/finish` and `/resume` back the controls.
Stage triggers return 409 from an incompatible state; re-clicking the current in-progress
stage resumes it. Stage transitions record the editor email (or worker identity).
Neither manual ticks, the local poller nor a future cron can bypass a gate.

HTTP **429** is an infrastructure delay, not an editorial rejection. Try configured backup
providers first; if none succeeds, return the unfinished job to MongoDB with exponential
backoff (15, 30, 60, 120, 240, then 300 seconds), honoring a longer `Retry-After` or provider
retry hint. There are at most eight deferred retries per job; hints over one hour fail
explicitly rather than scheduling an unbounded wait. Retrying does not turn stories into
holds, consume their validation retry or use rule-ranking fallback for quota failures.
Exhaustion fails the run before publication and leaves the last published edition intact.
Job errors, retry counts and availability timestamps expose the wait in run inspection.
A daily quota cannot be solved by backoff; capacity must recover or be increased.

**Runs & locations** shows pipeline progress, published/held counts and **Inspect run**
for each source, story (with held reasons) and job. Each cloud source collection runs in
its own authenticated Vercel function invocation; structured per-attempt JSON-line logs
are stored under `.newsbee-pipeline/logs/<run-id>` beneath the configured Drive folder
and are available from each job in **Inspect run**. **Health** shows current providers,
scheduler and queue, plus 7/30-day charts filtered by location: completed/failed runs,
published/held stories, source outcomes and average run duration. History uses recorded
run data, not estimated provider uptime. Every step writes structured JSON logs.
Runs that aren't progressing are marked **stalled** with the cause (no recent worker
call, rejected job call, worker dispatch failure, retries, expired leases).
In-progress stages still active after `NEWSBEE_RUN_TIMEOUT_MINUTES` (default 60, `0`
disables) are failed on the next worker call, tick or portal load. Each manually started stage gets
its own timeout; time waiting for an editor is neither stalled nor counted toward it.

Articles use short reported-style prose (up to 120 words), prefer dates/venues separately,
and receive complete-headline and unsupported-claim checks with one retry before holding.
Source-supported date context is allowed in event prose; mentioning the headline in a
summary is not itself a publication failure. Invented date words, unsupported factual
claims, repeated sentences, incomplete headlines, sensitive topics, unsafe source URLs
and geographic mismatches are still rejected. Presentation relaxations do not authorize
inventing missing context. Checks are rule-based safeguards, not a guarantee of factual
entailment.

Wikipedia and Bluesky discover **locally reported news**, not popularity statistics.
Their area is the selected town plus reviewed places whose centres are within **15 miles**
of its centre; county/state names alone do not qualify, and the broader state-news/hazard
radius is unchanged. Unknown coordinates do not expand this area. Wikipedia measures only
eligible local topics; its cache is location-specific and versioned. Bluesky searches for
recent reporting links naming the town and nearby places with the state qualifier, instead
of filtering a national trending list or requiring a minimum post count. It never treats
users' posts as factual reporting or retains their authors/text.

Both connectors fetch the original public HTTPS report and require a named publisher,
a publication date within seven days, a real headline and substantive locally relevant
body text. A generic topic description, a sidebar's town name or a page-view statistic is
not sufficient. The report's headline, publication date, publisher, source link and local
story details become the candidate; popularity counts stay out of writing prompts.
Items without this context are omitted with an observable `no_context` outcome. This does
not prove why a topic attracted attention, and the writer must not invent a reason or
report view counts as news. Saved editions are not silently rewritten by these changes.

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
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Drive writer key; use JSON to keep it distinct from the reader's email/private-key variables in the shared project |
| `NEWSBEE_PIPELINE_DRIVE_FOLDER_ID` | Existing Shared Drive folder for run artifacts and new channel folders |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` | Google sign-in (redirect URI `https://<host>/api/auth/callback/google`) |
| `CRON_SECRET` (optional) | Authorizes optional Vercel Cron calls to `/api/pipeline/tick`; cloud stages use Vercel Queues instead |
| `NEWSBEE_RUN_TIMEOUT_MINUTES` (optional) | Fail an in-progress stage after this time, excluding editor waits (default 60, `0` disables) |
| `NEWSBEE_AI_LINK_DISCOVERY` (optional) | Also let the model look for event links (off by default) |
| `NEWSBEE_READER_SITE_URL` | Full reader URL, `https://<host>/reader`; used only when inserting the default channel |

Deploy one Vercel project from the repository root using root `vercel.json`.
The journalist service owns `/` and its existing APIs; the reader owns `/reader`.
There are no HTTP dependencies between services, so no bindings are required.
See the [root deployment guide](../../README.md#deploy) for shared environment settings.

### Configure Google Drive

1. In Google Cloud Console, create or select a project, enable the **Google Drive API**,
   and create a service account with a JSON key.
2. Create a folder in a **Google Workspace Shared drive** for Newsbee's pipeline files.
   Service accounts cannot own new files in personal My Drive; a shared My Drive
   folder is not a Shared drive. Both Newsbee Drive adapters support Shared drives.
   Copy the folder's ID from the URL
   (`https://drive.google.com/drive/folders/<folder-id>`) and share the folder with the
   service account's `client_email`, granting write access (for example, Shared-drive
   **Content manager** membership). The same account needs
   access to the output-channel folders where published editions are stored.
3. In the journalist site's Vercel project, add `NEWSBEE_MODE=cloud`,
   `GOOGLE_SERVICE_ACCOUNT_JSON` containing the JSON key, and
   `NEWSBEE_PIPELINE_DRIVE_FOLDER_ID` containing the root folder ID. In the shared
   services project, reserve `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
   `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` for the reader account; the JSON variable
   supplies the separate writer identity. Keep credentials in Vercel's encrypted environment variables; never commit
   the key.
4. Redeploy the journalist site so the variables take effect.

In a separate-project deployment, the journalist adapter can alternatively use
`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` and `GOOGLE_SERVICE_ACCOUNT_EMAIL`. In this
shared-services deployment, keep those variables reserved for the reader identity.
If publishing reports a `GOOGLE_SERVICE_ACCOUNT_JSON` parsing error, correct that
writer JSON rather than falling back to the reader's credentials. Set `GOOGLE_SERVICE_ACCOUNT_JSON`
to the **entire contents** of the downloaded key file, including `{` and `}`. Use raw
JSON (one line or pretty-printed), not the filename, an API key, an OAuth client secret,
or a `GOOGLE_SERVICE_ACCOUNT_JSON=...` assignment. Preserve the private key's `\n`
escapes inside JSON strings.

Apply credential changes to the environment serving the failing deployment (Production
or the relevant Preview), then **redeploy**; changing a variable does not update an
existing deployment. In **Inspect run**, resume the failed run after redeployment.
Do not paste credentials into logs, issues, or chat.

The journalist site uses the configured pipeline folder directly: run artifacts are stored
in `.newsbee-pipeline/` and new channel folders are created in `output-channels/` beneath
that folder. It does not create an extra app-level folder. Each output channel stores its
own Drive folder ID in MongoDB; the reader site reads published editions from that channel
folder, not directly from the pipeline root. Existing channel folder IDs are kept; the app
does not move existing channel data. Drive API calls support Shared Drives, but the pipeline
folder must actually be on a Shared Drive for service-account uploads; sharing a My Drive
folder with the service account alone does not resolve its storage-quota error. If the
log reports `Service Accounts do not have storage quota`, move or recreate the configured
pipeline folder inside a Shared Drive and set the service account's membership to at least
Contributor; then update this folder ID in Vercel and redeploy.

The journalist service's `functions` in root `vercel.json` configures the private
queue consumer. Optional `/api/pipeline/tick` Cron recovery is not enabled. To enable
minute-by-minute recovery, add a top-level `crons` entry targeting that path and set
`CRON_SECRET`; scheduled functions require an appropriate Vercel plan.
Optional recovery only processes an editor-started stage; it cannot cross an editor gate.

Admins are documents `{ "email": "editor@example.com", "enabled": true }` in
`journalist_admins` (lowercase); the **Administrators** page adds more. Reviewed source
overrides (`config/*.json`) are seeded into `source_configs`; location-specific additions
are validated and stored separately in `location_source_links`.
