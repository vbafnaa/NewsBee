# Deploying Newsbee

The image implementation is maintained on `nkd/image_pipeline_integration`.
Pushing that branch does not automatically deploy or republish editions: `vercel.json` enables Git deployments only from `main`.
When deploying an approved revision, both existing services use the same MongoDB database
for `photo_assets`, `photo_assets_blobs` and `photo_assets_originals`. No additional image
storage service is required. The journalist service uses Sharp for decoding/cropping;
its lockfile includes the Linux native dependencies and its tracing root is the repository.
The reader serves stored variants without loading Sharp or requiring a live photo origin.

New runs default to `NEWSBEE_IMAGE_MODE=illustrated`, selecting reviewed AI watercolor assets without per-story photo or generation calls. The reader can override presentation with `NEWSBEE_READER_MEDIA_MODE=illustrated|photos|none`. See [the illustration pipeline](illustration-pipeline.md). Choose `agentic` for vision-reviewed photos, or `shadow` to compare decisions
before publishing agent-selected photos, or `current` for the baseline. Hosted vision
still requires a configured capable provider and the Agent model service to be selected
for the run. Set `NEWSBEE_LLM_<PROVIDER>_VISION=true` for confirmed compatible models, or
use the existing Gemini provider (`NEWSBEE_GEMINI_VISION=false` opts out). No paid service
is enabled merely by deploying. See [Agentic photo editor](image-pipeline-agentic.md).

Create one Vercel project with its Root Directory set to the repository root and
Node.js 24 selected. The root `vercel.json` builds two services independently:

| Service | Public paths |
| --- | --- |
| `journalist-site` (Next.js) | `/` and all paths outside `/reader`, including `/api/auth/*`, `/api/admin/*` and `/api/pipeline/*` |
| `reader-site` (Astro) | `/reader`, `/reader/api/*` and `/reader/_astro/*` |

The reader rewrites select base-relative Astro output paths with `destination.path`;
Vercel still passes the original `/reader/...` request path to the application.

The archived Python prototype is not deployed. There are no inter-service HTTP calls
or service bindings: each app accesses MongoDB and Drive directly. Local pipeline
self-calls stay within the journalist service. Queue consumers remain private,
even though the journalist service has public routes.

Project environment variables are shared by both services. Set `NEWSBEE_MODE=cloud`,
`MONGODB_URI`, `MONGODB_DATABASE`, model-provider credentials, Google sign-in credentials
and `AUTH_SECRET`. Set `NEWSBEE_READER_SITE_URL=https://<your-domain>/reader` for links in
email previews. Both services first look up the MongoDB `output_channels` document
whose `_id` is `NEWSBEE_OUTPUT_CHANNEL_ID` (default `reader-site`). An existing document
must have `enabled: true` and a valid `drive_folder_id`; disabled or malformed channels
and database/configuration failures are errors, never reasons to use a different folder.
Only an absent document falls back to `NEWSBEE_READER_DRIVE_FOLDER_ID`
(default `1S2uePphOd_25yandeFtQJ6iZvSz2ydYw`). Both services need read access to
`output_channels` and matching channel/fallback settings. This shared Reader target is
separate from the journalist-owned publishing channels, which remain supported. Preview
deployments are not created automatically: only `main` has automatic Git deployments enabled.
Without a Google Workspace Shared drive, set `NEWSBEE_ARTIFACT_STORE=mongo` instead: both
services then keep and read editions in MongoDB's `artifacts` collection and need no Drive
credentials.
The OAuth callback remains `https://<your-domain>/api/auth/callback/google`. Seed an
enabled account in `journalist_admins` before signing in.

To test the image branch, open the existing Vercel project's **Deployments** tab,
choose **Create Deployment**, and enter `nkd/image_pipeline_integration` or its
verified commit SHA. Select **Preview** and retain the repository-root project
configuration so both services build. Keep the production branch set to `main`.
Use preview-specific MongoDB and reader Drive settings for test runs; deploying
application code does not isolate a shared database or publish an edition.
The bundled watercolor illustrations require no image-generation API key.
After review, production deployment follows the normal PR merge into `main`;
an edition still needs the workspace's separate **Publish** action.

Set `NEWSBEE_INTERNAL_PASSWORD` to a strong private value for the internal maps and
`/api/maps/*` read endpoints. Use one server-side value; never prefix it with `NEXT_PUBLIC_`
or `PUBLIC_`. The source and edition maps and their read endpoints require only the shared
password, not a Google account or journalist administrator. The former `/interest-usage`
page now redirects to Google Analytics, which requires separate Google account access;
its existing aggregate `/api/maps/usage-map` endpoint remains password-protected.
Unlock sets an eight-hour signed, HttpOnly, SameSite=Strict cookie; production cookies
are Secure. Journalist sign-in does not bypass the password. An unset/empty value
fails closed (data APIs return 503); rotating it invalidates existing map cookies.
Unlock attempts are limited to ten per 15-minute window using MongoDB
`internal_access_attempts` with a TTL index. On Vercel the bucket uses an HMAC of the
platform-overwritten `x-vercel-forwarded-for` address (never a raw stored IP). Off Vercel,
all clients share a bucket: arbitrary forwarded headers or cookie deletion cannot evade
the limit. Shared networks can exhaust a bucket; wait for its next window. Unlock and
lock accept same-origin requests only. The journalist database identity needs
read/write/index access to that collection and read access to `reader_engagement`,
`reader_interest_signups`, `census_places`, `geographic_places` and `locations`.
The administrator-only **Clear reader data** page also needs delete and update access to
`reader_engagement` and `reader_interest_signups`, and read/write access to `reader_data_clears`.
Use **Lock maps** to revoke the current browser's map cookie.

Map access is read-only. Source inventory omits connector parameters; live edition
reviews are calculated without changing pipeline data. Source edits, discovery refreshes,
full item traces/overrides and pipeline operations remain behind journalist administrator
authentication under `/api/admin/*`. Source management is in each location workspace's
**Sources** tab. Neither the map password nor map access grants these privileges.

The usage map aggregates saved newsletter/requested-community coordinates, not readers'
physical locations, and sends no analytics to an external map service.
The low-resolution country basemap is a checked-in, public-domain Natural Earth dataset
(`apps/journalist-site/public/maps/land.json`); its source URL is included in the file.
It is context only, not a community boundary or a source of reader coordinates.
Reads are anonymous edition-view events (reloads count again), not unique readers or source clicks. New
signups save independent first-intent timestamps on the existing unique email/location
record. Older ambiguous consent histories are counted separately and excluded from intent
totals; no migration or invented historical split is performed. The map API returns only
aggregates, never signup emails. Optional date filters use inclusive UTC calendar dates.

### Development-only interactive usage map preview

The former `/interest-usage` dashboard redirects to Google Analytics. The retained
sample preview uses fictional data and does not require a Google account or map password.
To explore the sample, use the zoom buttons, wheel/trackpad, drag or touch pinch/pan. Focus the
map for arrow-key panning, `+` / `-` zoom and `Home` reset. **Reset extent** fits all
mapped communities in the current metric/location/date selection. Changing these
filters refits the map and recalculates the heat cells and marker groups. Panning
does not filter totals: the totals and table always include every filtered location,
including those without coordinates. Darker cells aggregate the selected metric;
numbered markers count communities. Select a group for a keyboard-accessible chooser
with exact per-community counts, or **Fit this group** to separate nearby locations.
Coincident communities remain selectable individually even at maximum zoom. Details
show all three metrics, independent of which metric colors the map.

For a credential-free local preview, run `npm --prefix apps/journalist-site run dev`
and open `http://127.0.0.1:3000/interest-usage/preview`. This development-only route
loads fictional in-memory counts for October 1–2, 2026, including nearby, coincident
and unmapped communities; it never calls live map APIs. Date and location filters
use the sample data. It returns 404 outside development and does not bypass the
password gate on any `/api/maps/*` endpoint.

## Run options when deployed

Runs use the same code locally and when deployed. See [Run options](../README.md#run-options) for
the settings and [APIs and paid calls](../README.md#apis-and-paid-calls) for the keys.

- Runs never publish on their own: each finished edition waits as **Ready to publish** until a
  signed-in journalist publishes it in the location's **Publish** step. Set `NEWSBEE_RUN_MODE=manual`
  to also stop after collection and after writing.
- Exploration and relaxed runs are allowed, and can be published like any other. Setting
  `NEWSBEE_GUARDRAIL_PROFILE=exploration`, `NEWSBEE_ACCESS_POLICY=relaxed` or
  `NEWSBEE_GUARDRAILS_OFF` here makes them the default for every run.
- Caps are off when `NEWSBEE_GUARDRAILS_OFF` is unset; set it to `none` to keep every rule group on.
  See [Limits](../apps/journalist-site/README.md#limits).
- The `fixture` search provider is refused, and so are agent tools at `/api/agent-tools`.
- A run you start needs Vercel Queues, not cron. Whether Queues are available on your plan needs
  confirming.
- Paid services stay off unless ticked for a run or listed in `NEWSBEE_PAID_ALLOW`. On a deployed
  environment Ollama isn't available, so list `gemini` there, or a run has no model to write with.

## Location removal and artifact cleanup

Administrators use **Settings → Remove location and generated files** and type
the location ID to confirm. The map password grants no removal privilege. The service
account needs permission to delete the location's generated files in the configured
reader and pipeline Drive folders, not just upload permission; shared folders are never
deleted. No new environment variable or data migration is required.

Active runs and executing workers block removal. Partial cleanup remains visible and
retryable, with new pipeline/source work blocked for that location until it completes.
Keep the reader/pipeline storage configuration unchanged during an incomplete cleanup.
See [removal scope and retained reader data](../apps/journalist-site/README.md#remove-a-location)
before confirming; this is not a reader-data erasure operation.

## Model usage pricing

`/model-usage` requires administrator access and uses `/api/admin/model-usage`; it does not
run model health probes or generate content. Choose a rolling 24-hour, 7-day or 30-day
window and optionally a location. Usage records expire after 35 days. Each pipeline job
records location/run attribution; manual discovery records its location. Older records
without context are explicitly unassigned, not attributed by guesswork.

Set both `NEWSBEE_MODEL_<NAME>_INPUT_COST_PER_MTOK` and
`NEWSBEE_MODEL_<NAME>_OUTPUT_COST_PER_MTOK` in USD per million tokens for each configured
model. `<NAME>` is the uppercase configuration identifier, for example `GEMINI`, `OPENAI` or
`GEMINI_LIGHT` (any provider's light model is `<NAME>_LIGHT`). A light model does not inherit its
main model's price. Gemini usage records show provider `gemini` for both its models; exact model
IDs distinguish them. Model calls bill one **Model calls** budget (`model`) whichever provider
serves them; `gemini` and `openai_compatible` in `NEWSBEE_PAID_ALLOW` still mean `model`.

For exact models, including ones no longer configured, optionally set `NEWSBEE_MODEL_PRICING`
to a JSON array. This overrides provider-default rates only for a matching provider/model
pair. For example, with **illustrative rates, not a current pricing quote**:

```json
[{"provider":"example","model":"model-id","input_per_mtok":0.1,"output_per_mtok":0.4}]
```

Invalid JSON, duplicate pairs and invalid/negative rates produce an explicit configuration
error. Configure both rates; zero is supported for a known free model. No prices are
guessed. Only calls with both reported token counts and configured rates are priced.
Partial totals are labeled as subtotals with a priced-call count; failed attempts with
missing token metadata remain unpriced. Output includes separately reported Gemini reasoning
tokens. Health checks are not generation calls.

Estimates apply current configured rates to the selected history; they are not historical
rate snapshots or invoices, and do not account for cached-token/batch discounts or other
provider adjustments. No prompts or generated text are stored in usage accounting.

## Drive credentials and local routing

Not needed with `NEWSBEE_ARTIFACT_STORE=mongo`.

Both apps currently read `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`. To preserve separate Drive identities within
the shared environment, put the **reader** credentials in those two variables and
the **writer's complete JSON key** in `GOOGLE_SERVICE_ACCOUNT_JSON` (which only the
journalist adapter reads). Also set `NEWSBEE_PIPELINE_DRIVE_FOLDER_ID` for the writer.
Grant the writer write access to its pipeline and reader folders, and the reader Viewer
access to the reader folder;
keep all credentials server-side. Shared environment variables are not a security
boundary between the services. Both Drive adapters support Workspace Shared drives.
Use folders in a Shared drive for service-account publishing: service accounts
cannot own new files in personal My Drive. A folder shared from My Drive is not
a Workspace Shared drive, and Vercel configuration does not change that limitation.

The journalist service's `functions` configuration in root `vercel.json` preserves
the Vercel Queues trigger for portal-started runs. Optional Cron recovery is not
enabled; enabling it requires `CRON_SECRET` and an appropriate Vercel plan.

To exercise the single-domain routing locally, install both apps' dependencies using
the [root README's setup commands](../README.md#run-locally), configure local
MongoDB/Drive/model settings, and run
`npx vercel dev -L` from the repository root. The console is at `/` and the reader
at `/reader` on the URL printed by Vercel. `vercel dev` does not start MongoDB or
Ollama; the existing `npm --prefix apps/journalist-site run local` launcher remains
available for the standalone local stack.

Vercel CLI 64 currently rejects service-hosted queue triggers in local mode
(`DEV_QUEUE_FUNCTION_UNSUPPORTED`). For routing-only checks, use a temporary copy
of `vercel.json` without the journalist `functions` entry and pass it with
`vercel dev -L --local-config <temporary-config>`. Keep the queue trigger in the
production config; queue delivery must be checked in a deployment.
