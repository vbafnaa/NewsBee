# Journalist site and cloud pipeline

Next.js admin console plus the TypeScript port of the Stage 1 pipeline (`pipeline/`). It
runs locally with stand-ins, or on Vercel with MongoDB Atlas, Google Drive and Gemini.

## Run locally

Photo sourcing now offers **Agentic**, **Compare** (shadow), and **Current** modes in the
kick-off panel, independent of the discovery flow. Agentic uses a visual brief, bounded
searches, pixel review and an independent crop critic. Hosted vision requires the **Agent
model** service to be ticked; local Ollama requires an installed vision model and
`NEWSBEE_OLLAMA_VISION=true`. For compatible hosted providers set
`NEWSBEE_LLM_<PROVIDER>_VISION=true` only when the selected model supports image inputs.
Without capable/permitted vision, agentic photos remain absent and the story continues.
Setup, quality rules and limits: [Agentic photo editor](../../Docs/image-pipeline-agentic.md).
### Accounts and encrypted API settings

Set server-only `NEWSBEE_OWNER_EMAIL` to the verified Google account that owns this
workspace. The owner is bootstrapped by that exact normalized email, never by
account age or insertion order. **Users** (`/administrators`) lets only the owner
add, reenable or disable editors; the owner cannot be disabled. Enabled membership
is rechecked on every authenticated request and execution check. Location removal
and reader-data clearing are owner-only. Internal maps retain their separate
password gate and read-only access.

**Environment & API settings** (`/account`, in Operations) has a field for every service a run can use, by what
it does: model providers, in the order runs try them, each with an optional light model that the
model check and the agent use (any provider, not only Gemini);
Dorking (SerpApi, SearchApi, and Bright Data's API key, SERP zone and Web Unlocker zone); Search
(Exa, Tavily); Opening pages (ScrapingBee, Jina; Bright Data uses the fields above); and Home
sales (ATTOM); Video production (fal.ai). TypeSafe and OpenRouter stay parked under Jev.
Non-owner journalists must supply their own keys for each service they use; deployment
credentials never fill their missing keys or add fallback model providers. Only the exact
configured owner may use deployment defaults or personal overrides.
Personal API keys are write-only and stored in `journalist_credentials`,
encrypted with AES-256-GCM. Provision server-only
`NEWSBEE_CREDENTIAL_KEYS` as a JSON object mapping key IDs to base64-encoded random
32-byte keys, and `NEWSBEE_CREDENTIAL_ACTIVE_KEY` as the active ID. Generate key
material with a cryptographically secure generator in your secret manager;
never commit it or put it in a `NEXT_PUBLIC_*` variable. For rotation, retain old
IDs for reads, add a new ID and select it as active. Replacing a profile encrypts
it under the active key. Back up the keyring securely: losing an old key requires
revoking and reentering the affected profiles.

GET `/api/account/settings` returns only masked metadata, profile version and
configured capabilities (not external validation). PUT accepts
`{source:"personal",config:{modelProviders:[...],integrations:{...},tavilySearchApiKey,
lightModel,modelDailyCalls}}`; omitted fields preserve saved values, omitted/blank
secret values preserve keys, and explicit `null` removes a key. Provider rows
follow `ProviderConfig` in `pipeline/core/config.ts`, using unique names. A
supplied provider list replaces that list; an empty list removes all providers.
Confirm **Supports image input** for personal vision-capable providers used by the image
pipeline; the optional `vision` flag is saved with each provider and preserved on replacement
when omitted. This capability never grants access to a deployment API key.
DELETE explicitly revokes the whole profile. Replacements and revocations
atomically increment the profile version, invalidating unfinished runs bound to
the previous version. Validation is structural only and never calls providers.

Browsing and configuration work without API keys. For non-owners, omitted or blank fields
preserve saved personal keys; explicit null clears the key and disables that service.
Only their personal model providers run, in saved order. For the owner, personal keys
override matching deployment values, with remaining deployment providers available as fallback.
No database, OAuth, or other infrastructure variables are editable here. The exact
configured `NEWSBEE_OWNER_EMAIL` account may also explicitly select the deployment-only
credential source, which automatically uses environment credentials when no stored profile exists:
effective `source:"environment"`, `version:0`, `automatic:true`, without writing a credential row.
A revoked profile blocks execution until replaced. The local sign-in bypass requires explicit `NEWSBEE_MODE=local`,
localhost, no `VERCEL`, and a nonproduction runtime.

Changing the effective credential source is an unsaved form change: click **Save
personal profile** or **Save deployment defaults** and wait for confirmation.
Saving an explicit deployment selection is optional for an automatic owner;
it creates version 1 and pauses any unfinished version-0 work until explicit
reconnection. Revoking automatic defaults also creates a version-1 tombstone:
the lack of personal keys never resurrects deployment access. Later replacements
increment the stored version normally. Reloading resolves the effective source.
Selecting deployment defaults does not provision models, keys or budgets.
The effective capability summary reflects personal credentials for editors and owner-only
deployment fallbacks, without returning secrets or probing providers. Editors are not shown
deployment credential placeholders or deployment readiness. Missing required model, search or
enabled integration keys block the relevant action with settings guidance, even when the
deployment has those keys. Actions do not require keys for providers they do not use.

If the source selector is absent, the account is an editor: only the exact
`NEWSBEE_OWNER_EMAIL` account may select deployment credentials. Correct missing or
mismatched owner configuration in the deployment's secret manager; do not promote
the oldest user or infer ownership from a stored role. No keys are required for
login, browsing or settings reads.

New edition/map buttons check their respective selected options. **Restart run**
checks that historical run's saved options and kind, creates a new own-sponsored
run, and does not reuse an old Admin approval. Historical unbound runs never gain
paid retry/resume rights from a new profile; unfinished legacy work still requires
explicit owner claim or cancellation. Paused and editor-waiting work still holds
the global slot. The execution notice reports profile, sponsor, approval and slot
blockers rather than silently enabling spend. Disabled pipeline actions expose
their own model/search/budget, plan, sponsor or slot reason on hover and keyboard
focus, including readiness loading/errors. Edition, map and historical-restart
requirements are not conflated.

For isolated UI checks, `node scripts/account-ui-fixture.mjs --deployment-defaults`
seeds fake deployment model/search configuration, signed owner/editor sessions and
an in-memory database. Omit the flag to check missing deployment configuration.
External fetches are blocked and pipeline start/reconnect/spend endpoints are mocked;
never use real deployment secrets or this fixture as evidence of real paid execution.
Use `FIXTURE_APP_PORT` and `FIXTURE_PREVIEW_PORT` to choose unused ports (defaults:
3007 and 3010). Sessions share cookies on the same hostname across ports; coordinate
identity changes with anyone using another local preview.
Add `--workspace-review` for a fictional completed run with its funding records. The fixture-only internal-map password is `fixture-maps-only`.

Follow [Run locally](../../README.md#run-locally) in the root README: Node 24 and npm 11, a
model (an API key in `apps/journalist-site/.env.local`, or a running Ollama with
`qwen3:4b` pulled), then `npm run local` from this directory after `npm ci` here and in
`../reader-site`.

`npm run local` (`scripts/local-stack.mjs`) starts a local MongoDB on port 27027 (data in
`.local/stage2/mongo`), this site on http://127.0.0.1:3000, the reader site on
http://127.0.0.1:4321/reader, and a pipeline tick every 5 s as a recovery aid. Drive is a
local folder (`.local/stage2/drive`), Google sign-in is skipped on localhost, and
`.env.local` here is read by both the console and the pipeline. Set `MONGODB_URI` to use
your own database instead, or `NEWSBEE_LOCAL_TICK_SECONDS` to change the tick.

On **Overview** (`/locations`), search for a town, select a suggestion and click **Add
location**. Its workspace has a tab for each production step. **Publishing channels** configure
Reader and/or video destinations and do not contain duplicate workflow controls. In **Collect sources**,
click **Start source run**, then accept or reject the pages it found; **Sources** is the separate
inventory of saved sources and their review decisions. In **Collect stories**, choose the mode,
then **Collect stories** (**Start collection** in manual mode). Each step shows only the options for
its own kind of run, laid out rather than folded away, with paid-service budgets open. There is
one kind of run: no test, training or final purpose. Each run card says who started it and
whether it uses their own keys or the deployment defaults; call details live in the run
inspector.
The run collects and writes the edition with no further clicks, then stops as **Ready to
publish**: it frees the newsroom slot but puts nothing on the reader. In **Publish**, anyone signed
in reviews it and clicks **Publish**. With
**Manual** run mode it stops after collection (**Start authoring**) and after writing (**Write
front page and email, then publish**), and the local poller never crosses those stops.
Census and library directories are prepared automatically on first use, so that first
search can take a minute. Publishing adds the location to the reader's edition picker;
directory search also finds saved communities and towns without an edition and lets
readers register interest.

Under autopilot, a run that collects no usable items ends with that reason. In manual mode,
the console shows **Collection finished — no usable items** and disables authoring. Use **Review sources** to inspect coverage and
**Retry collection** to cancel the empty attempt and start a fresh collection, preserving
its history. The authoring API also rejects attempts with no persisted, usable collected
items; source summary counters alone do not enable authoring.

### Console pages

- **Overview** (`/locations`, home): a searchable directory of location workspaces.
  `/dashboard` redirects here.
- **Locations** (from `/locations`, then a location), with the production steps
  edited in one place:
  - **Overview**: where each step stands (sources, when the map was last refreshed and how many
    proposed sources await review; the latest edition) and the location's alerts, each with the
    action that fixes it.
  - **Sources** is the saved source inventory and review workspace: accept or reject with a reason,
    change a source's window, add a source, and see each discovery method's last result and reader
    source suggestions.
  - **Collect sources** starts and reviews source map runs. It opens with
    how sources reach an edition under the current settings: whether runs are in test mode, and
    whether editions read only accepted sources. **Source runs** (described under Source map
    below) starts a run with its settings by stage and reviews it page by page, with bulk decisions
    and **Compare runs**. Its decisions follow the run's mode: normal runs update the saved source
    review, while isolated test runs keep their decisions with the run.
  - **Collect stories** runs the saved source map: **Collect stories** with only the edition options, the run's stages,
    the item explorer with **item trace** and its actions (force in or out, pin, extract details and
    rewrite, collect a source again, reassemble), held stories, reader stories and family notices,
    and edition run history. Runs collect source items, deduplicate and rank story candidates, write
    stories and produce the edition front page and email; this tab also provides run inspection and
    review tools. Reader-specific submissions and family notices are reviewed here.
  - **Publish**: every finished edition, **Ready to publish** or published, with its
    stories, funnel and readers' problem reports. **Publish** puts an edition on the default reader;
    **Make live** puts an earlier one back. The reader shows the edition published last. Publishing
    needs no keys and no newsroom slot, so any signed-in journalist can do it.
  Problem reports are reviewed in **Publish**, and the live reader is linked from the workspace.
  - **Settings**: the location profile and, for owners, removing it.
  Older source, edition, publish, and video `?tab=` links open the matching workspace tab.
  Reader story submissions can include an optional captioned, credited photo: review the
  image and permission confirmation with the text before approval. Pending/rejected images
  remain private; the authenticated photo endpoint serves the editor preview. Approval
  publishes the story and photo together.
- **Publishing channels** (`/publishing`): configure Reader-site/edition-feed and/or video
  destinations, select the communities covered by each, and manage each optional URL. The
  Sources, Collect sources, Collect stories, and Publish steps stay in each location workspace. A channel with a
  video destination also includes video creation for its selected locations.
- **Source map** (`/locations/<location>/source-map`): the read-only source network for that
  location. The global `/source-map` page remains available for cross-location review. Edit the
  inventory in **Sources**; collect and compare discovery runs in **Collect sources**.
- **Edition map** (`/edition-map`): read-only. **Edition funnel** (formerly Run funnel) shows one
  run from its first search to its printed edition, in five phases (Find, Collect, Filter, Select,
  Print), for either flow. Selecting a stage lists what came in, what was left out and why, with
  filters for topic and who decided, and **Trail** shows one item's full path. The page also shows
  the run's options, cost per service, sources by category, topic coverage, the agent's plans and
  what strict rules would have stopped, and a live run updates as it goes. **Compare editions**
  (formerly Compare runs) puts two edition runs side by side: what each collected, kept and printed. Two source runs are compared in **Source runs → Compare runs**: pages found and accepted by category, and the accepted pages only one run found. Old `/source-map?mode=edition` and
  `?view=compare` links redirect here.
- **Source map** (`/source-map`), with two tabs, read-only for everyone. A signed-in journalist
  sees it inside the workspace, with links to edit in the location's **Sources** tab; anyone with only
  the internal password gets the map layout.
  - **Source runs** (`?tab=runs`, and in the location's **Collect sources** tab, where it can be edited) is for
    testing Pipeline 1. Pick a location, then **+ New run** or a past source map run. A new run shows **Next run settings** by stage: Access (Respect site
    rules; unticked is Relaxed), Search (fixed readers always; the agent loop; Dorking
    through Bright Data or SerpApi, Exa and Tavily, which need the agent loop; and, outside test
    mode, whether to read every fixed reader again), Scrape (fetcher and Jina always; ScrapingBee
    and Bright Data as paid fallbacks), Code checks (always on) and Think (the model check and
    final review; switching the check off is an advanced baseline test). Relaxed and the check off
    are test options that work locally and deployed; Respect site rules and the check on stay the
    defaults, and each run records which it used. **Start source run** goes through the existing
    map-run start path and its refusals (only what can't work deployed, such as the fixture search
    provider). The settings become run options (`pipeline/trace/source-run-settings.ts`); model
    budgets stay as the defaults set them.
    In test mode (`NEWSBEE_SOURCE_RUNS_ISOLATED`, on by default; see
    [test mode](../../README.md#the-model-check-the-final-review-and-saving)), every run starts from
    scratch, keeps its own results and leaves All sources and editions untouched; the page says so.
    A past run shows **Settings this run used** (read back from its recorded options), how many
    runs have finished, and **What happened**: how it ended (goal met, dried up, which limit, or
    fixed readers only), and under **Limits, stages and categories** the run's limit meters, the
    stage funnel (found, opened, rejected by code check, rejected by the model check, passed both) coloured
    by tool, and category coverage. A stage or category filters the page table.
    After the free readers (and their model checks) finish, the agent works in **rounds**
    (`pipeline/agent/map-sources.ts`): one plan call picks each category's next angle and writes a
    query for every category × tool cell whose turn it is; code runs the searches, drops sites the
    free readers or earlier rounds already have, and merges what several tools found; a few triage
    calls propose or skip every result (40 proposals a round at most); code opens and checks the
    proposals, then the model check judges them 25 a call. Each round is saved after every step, so
    the 200-second jobs carry it on. Each tool searches every category in turn, with an even share
    of its cap (default budgets: Exa and Tavily 60, Dorking 20, the agent's model 100; so 6, 6 and
    2 a category over ten categories); a turn whose query code refuses still counts, as a miss; a
    cell goes dry after 3 misses in a row (2 for Dorking) or once it has tried every
    angle (`pipeline/agent/search-angles.ts`, families and vocabulary in `playbook/general.yaml`),
    and the run ends when every cell is dry or unavailable, or the model budget can't cover another
    round. Every run is exhaustive now; runs from #134 that chose Enough still show it. The
    **Search grid** shows each cell's searches, hits, angles, round and share, which cells wait for
    their turn, refused turns ("Missed: query refused, …"), and hits filed under another category
    than the one that searched; **Angles** shows
    each category's sequence and which tools hit on each. A page several tools found is listed
    once with each tool's tag, and **By tool** counts every result each tool returned and those
    only it found; a page a fixed reader found first counts for the tools only under "Results
    returned". Locally, `NEWSBEE_SEARCH_PROVIDER=fixture` runs the agent for free from the
    location's own source map: it is admitted without search keys or budgets, has no meters or
    shares, and is refused deployed. What has to change before this setup goes to production is in
    [Docs/source-runs-before-production.md](../../Docs/source-runs-before-production.md).
    **Every page** lists each page the run touched, one section per category in the usual order
    (pages with none last, under Uncategorised), each headed with its count of what the filters
    show, e.g. "Police, fire and safety (7) · 3 passed both · 1 link only · 2 rejected", and sorted
    passed both, link only, rejected by the model check, rejected by code, then not opened
    (`groupPages`): category, who found it (reader or tool, query,
    agent step), what opened it and the readers tried first, the code check, the model check, and
    Decision and Reasoning. The code check has three states: **Passed** (green; unclear locality
    included, which the model check decides), **Link only** (amber: a page code couldn't read but
    kept as a link, such as one blocked by a crawl delay, a platform we never read, or a paywalled
    or `nosnippet` page; it still goes to the model check, and the stage **Kept as a link only**
    lists them) and **Rejected** (red: dropped, never sent to the model check). A page never
    opened or checked shows a dash. A page the agent's tools found but nobody opened says why when the
    run's record shows it (`skipReason` in `pipeline/trace/source-runs.ts`): code's facts first
    (the never-read list, another address for a page already in the run, already on the map, a site
    rejected, unreadable or already opened this run, a site on the map), then the agent's own few words
    (`skipped` in its step reply, kept on the lead), then a category already covered or a run that
    ended soon after. Runs from before this show the old "didn't choose it" line. For a test-mode run they are kept by page (`page_decisions`), so a page
    decided once shows its decision in every run, and the run's own results and the source map
    stay as they were (`POST /api/admin/locations/{id}/source-runs/{run}/decisions`, one source id
    for a row's cells or several for bulk); for a run that wrote the source map they are saved to
    the same review store as All sources. Filter by address, tool, category, stage and **Disagrees
    with the model check**; select rows to accept or reject them in bulk with one reason
    (`POST /api/admin/locations/{id}/source-map/reviews` for those runs). The model check column
    also shows the final review's strength and likely duplicate. A row opens a drawer with the
    page's timeline. **By tool** counts each tool's searches, pages, passes, acceptances, pages only
    it found and use of its limit; **Agent log** lists every agent step and why it stopped. It all
    comes from what the run recorded (`pipeline/trace/source-runs.ts`): the run's options, the
    decision log, the agent's state, its searches and paid calls, and its sources (its own store
    in test mode, otherwise the source map). The Run picker lists every recorded map run.
  - **All sources** (formerly Source network) is the global inventory and location filter. Its table keeps the
  **Source**, **Location**, **Type**, **How found**, **Window**, **Health**, **Initial Status**,
  **Model check**, **Decision** and **Reasoning** columns together; when filtered to one location,
  the Location column is omitted. On narrow screens the table scrolls horizontally rather than
  hiding or squeezing those fields. It shows each source's
  **Initial Status** (what the pipeline gave it, with the live status beneath once they differ;
  a link-only source shows **Non-scrapable** with the reason it isn't read, unless it is rejected,
  paused or dormant. This is display only: `link_only` still decides what is collected, and
  accepting such a source keeps it link-only),
  **Model check** (Accept or Reject with its reason code, reason and evidence, or why it wasn't
  judged, and the final review's strength and likely duplicate; filterable by verdict; a model check
  rejection shows Initial Status Rejected and can be overruled with Accept),
  **Decision** (Accept, Reject or blank) and **Reasoning**. Anyone who can open the map can read
  these; they are changed only in the location's **Sources** tab.
  Accept makes a source active (a pinned one stays pinned) and it then stays active however quiet
  it gets; Reject stops collection; clearing restores the initial status. Reasoning is a fixed list that
  depends on the Decision (`pipeline/sourcemap/reasons.ts`); changing or clearing the Decision
  clears it. Other asks for an explanation, saved when you leave the box, and shows as incomplete
  without one. Free text from before the list stays as a read-only **Earlier note**. Later map runs
  never undo a label, and every change is also appended to `source_reviews` with the code, its
  label and any Other text, which keeps its history even if source records or the location are removed.
  All source editing (decisions, windows, manual links and refreshing the map) is in the location's
  **Sources** step. Rejecting happens only through
  Decision, and a rejected source can't be re-added until its Decision changes.
  The tables group these two as your review, with a short key above them: the Decision is a recorded
  verdict and the only one of the two that changes what runs read; Reasoning says why and changes
  nothing on its own, though the model check reads past decisions and their reasons as examples.
  There are no separate Pin, Pause or Activate buttons: Accept reads a source (a pinned one stays
  pinned, a paused one is read again) and Reject stops it. Pinned and paused statuses still work as
  before, and a failing source can still be paused from its alert. Full item traces
  and overrides remain in the workspace's run item explorer while retained.
- **Analytics → Interest and usage map** (`/interest-usage`), opening inside the workspace for a signed-in
  journalist and behind the internal password otherwise, like the other maps: separate reads, subscription and launch
  interest metrics; interactive zoom/pan by mouse, touch or keyboard, geographic heat grid,
  overlapping-community chooser, exact counts, UTC date filters and location drill-down,
  including requested locations not yet onboarded. The interactive map needs no activation
  flag; see [map controls and development sample preview](../../Docs/deployment.md#preprod-only-interactive-usage-map).
- **Clear data** (`/clear-data`, owner only) has two parts. **Reader data**: choose impressions, clicks, shares
  (`reader_engagement`), launch-interest signups, subscriptions or legacy signups
  (`reader_interest_signups`), for one location or all of them. Only engagement is selected
  by default; signup emails are never cleared implicitly. Counts, selected/kept categories and
  a typed scope confirmation precede deletion. Mixed signup rows keep their email, shared
  consent and unselected registrations; selecting every remaining intent deletes the row.
  Subscription and legacy counts include registrations removed from retained mixed rows,
  not just deleted email records. Nothing else is changed. The API requires a nonempty,
  explicit `data_types` array using `impressions`, `clicks`, `shares`, `interest`,
  `subscriptions` or `legacy_signups`; missing/unknown categories fail without deleting.
  Each clear is logged in `reader_data_clears` with who, when, scope, selected categories
  and actual counts, including partial failures, and the page lists the last ten. Older audit
  entries retain their historical engagement-plus-interest meaning. Afterwards the
  usage map drops only the selected evidence, and future runs rank without deleted engagement;
  published editions and the per-item ranking explanations of past runs stay as they were.
  **Source data**, for rebuilding a source map from scratch: nothing is selected by default; choose
  discovered sources, editor-added sources, reviews and labels (with a download of them first),
  decisions on source-run pages (`page_decisions`), Model check verdicts and review flags, test-mode
  source runs' own stores (`source_run_<run id>`), pins, pauses and windows, discovery history,
  cached discovery, saved addresses or source health,
  for one location or all. It is refused while a run is open for that scope, and each clear is
  logged in `source_data_clears`. Editions, runs, collected items, reader data and locations are
  never touched. Afterwards, **Start source run** in the location's Collect sources tab rebuilds it.
- **Inbox** (`/inbox`): held stories (with the rule that held them), reader source
  suggestions (approve checks the site and pins it on the map), problem reports from
  readers, reader stories and family notices.
- **System** (`/health`): **Pipeline** shows the scheduler, the job queue (jobs of open runs only),
  locations, sources needing attention and run trends. **Model usage** (`/health?view=usage`) shows
  24-hour, 7-day and 30-day views of actual models used, input/output tokens, estimated USD cost and
  pricing coverage, by location, pipeline role and UTC day. With API keys set per account, there is
  no shared provider to check, and that isn't counted as a failure. `/model-usage`, `/alerts` and
  `/discovery` redirect to where their content now is.

Both internal maps open for a signed-in journalist with no password. Without an account, they
need the shared `NEWSBEE_INTERNAL_PASSWORD`; the password cookie is checked first, so a password
read never looks up a sign-in. Their `/api/maps/*` endpoints accept only reads;
`/api/admin/*` retains separate administrator authentication for
workspace data and all source edits, item overrides and pipeline actions.
The password is never sent to client bundles. With no password set, only signed-in journalists
(including the localhost admin) can open the maps. Unlock lasts eight hours; changing the password revokes existing tokens.
Cookies are HttpOnly and SameSite=Strict, and Secure in production. Unlock/lock require
same-origin requests; persistent throttling allows ten unlock attempts per 15-minute
window. See [deployment](../../Docs/deployment.md) for bucket scope, database
permissions and the usage-history limits. Public editions retain source links only, with
no map or editorial ranking details.

### Sponsored execution and the newsroom slot

Approved users may browse without keys. **Environment & API settings** shows structural
capability status; it does not send provider probes. Run controls explain missing
model, paid-search and enabled optional-integration credentials. Database, Google
sign-in, artifact storage, Drive and publishing remain centrally managed.
Only the configured owner may use deployment API credentials. Everyone else must use personal
keys, including one-off source discovery and worker model calls. The owner may select a
deployment-only profile explicitly.
Optional paid services still require a configured key and an enabled run budget when selected.

Each map/edition run persists stable sponsor and initiating principal IDs, credential
source/version and immutable plan hash. Queue credentials authorize transport,
not spending. Workers claim a job before resolving its sponsor's providers; writing,
ranking, extraction, discovery and agent runtimes share that identity. Every outgoing
transport call rechecks enabled membership, current credentials and the active run.
Already-sent requests cannot be recalled. Replacing/revoking credentials or disabling
an account pauses unfinished sponsored work; reenabling access alone never reconnects it.
The person who started the run must explicitly **Reconnect this run**. Other editors can view
shared results and do ordinary editorial work, but cannot retry, resume, rewrite, recollect or
reassemble using its keys. A restart is a fresh run on the keys of whoever restarts it.

Mongo enforces **one unfinished map OR edition run across the whole newsroom**.
The `one_unfinished_newsroom_run` unique partial index on `pipeline_runs.admission`
reserves `"newsroom"` while mapping, collecting, authoring, finishing, publishing or
waiting for an editor. Pending jobs and credential pauses retain the slot. Mapped,
published, failed and cancelled runs release it; within-run worker parallelism remains.
New-run/batch/restart conflicts fail visibly, not as a second queued location. Batch
starts are disabled. Reassembly of a failed run reacquires the same indexed slot
before modifying its draft. The UI links to the blocking location and its controls.

### One kind of run, on your own keys

Every map and edition run is the same kind of run. There is no test, training or final purpose,
no owner-funded backup and no approval inbox. Whoever starts a run pays for it:

- **The owner** (the exact `NEWSBEE_OWNER_EMAIL` account) uses the deployment's default keys
  automatically, or can choose a personal profile that overrides them.
- **An editor** must save their own model, search or service keys in Environment & API settings
  for the actions they use. Missing personal keys block those actions, regardless of deployment
  keys. Journalists cannot use another journalist's saved keys.

If a run's provider fails, the run stops with the reason; it never falls back to anyone else's
keys. Provider safety refusals do not trigger another model. Per-attempt
`journalist_funding_audit` records the provider, model, sponsor and credential version, run and
outcome; run details display this audit. No prompts, keys, raw provider errors or
credential-bearing URLs belong in logs.

Runs started before this change may still carry a purpose and an approval id. They keep running
on the keys of the person who started them; the approval no longer adds anyone else's keys. The
`NEWSBEE_ADMIN_LLM_*` settings are no longer read and can be removed from each environment.

### Rollout and recovery (preprod before production)

Provision **separate** owner identity and credential encryption keyring in each environment's
server-side secret manager. Do not copy
preprod keys into production or expose any of them to browser configuration.
The app's Mongo identity needs read/write access to `journalist_admins`,
`journalist_credentials`, `journalist_execution_audit`,
`journalist_funding_audit` and existing pipeline collections, plus create/list/drop
index permissions for startup migrations. No other user needs direct credential
collection or encryption-key access. Back up encrypted profiles and keyring separately.

Existing approved emails retain access as editors unless they exactly match
`NEWSBEE_OWNER_EMAIL`; stable principal IDs are assigned idempotently. There is no
first-user/oldest-account owner inference. Bootstrap that exact owner, whose absent
profile automatically resolves deployment defaults; personal overrides are optional.
Then use **Users** to add editors. Effective credentials recheck enabled membership
and exact owner designation for readiness, bindings, claimed jobs, every provider
call, approvals and one-off discovery. Losing the designation removes owner-only
deployment-source selection; old environment-source bindings fail closed until explicit
recovery. Editors never inherit deployment API values, including profiles saved before new
personal-key fields were added. Existing editor runs are checked against personal credentials
before further provider calls; reconnect with complete personal keys when needed.
Keep old encryption key IDs available until all profiles have been reencrypted through
replacement; removing an unreadable key intentionally blocks spending, not funding
from deployment credentials.

Unbound legacy unfinished runs are paused, never assigned funding from trigger text.
The owner may explicitly claim the remaining run with their configured profile or
cancel it. Historical multiple unfinished runs are retained and visibly paused:
inspect them, explicitly cancel excess attempts, then claim/reconnect the survivor.
Do not delete the global admission index to bypass the gate. If publication was
interrupted, reconcile centrally published artifacts before any manual recovery;
normal cancellation remains unavailable once publication begins. Credential/approval
failures pause jobs without consuming retry attempts, preventing retry storms.
Rollback must first stop/drain workers and resolve active bindings; old code does not
understand these funding/admission guarantees and must not resume new-format jobs.

### Isolated account-flow acceptance

After `npm ci` in journalist-site and reader-site, run
`node scripts/account-ui-fixture.mjs` from journalist-site and open
`http://127.0.0.1:3010/fixture/session?as=owner` (also `editor` or `other`).
This starts the real Next UI with a fresh isolated Mongo and signed fixture sessions.
It does not add a login bypass to deployed routes. Users and encrypted settings are real; the localhost proxy mocks pipeline starts,
paid run actions and reconnects, writing UI state but **never jobs**. External fetch
is blocked in the fixture Next process. Use only dummy keys; never production data.
`/fixture/reset` clears only fixture runs. Stop the fixture when done.
Mock provider/worker regression tests independently exercise actual admission,
sponsor checks, per-call disable/revoke, replacement and reconnect.

**Run orchestration** shows recent attempts with their stages, stories and expandable per-job
logs (including source outcomes and errors). **Cancel run** stops queued jobs and marks a
collecting, authoring, finishing or editor-waiting attempt cancelled; a job already executing may finish before its
cancellation is reflected in the log. Once publication begins, cancellation is unavailable
to avoid partially published editions. **Restart run** creates a fresh attempt for a
published, failed or cancelled run; the earlier attempt remains in history. **Resume**
re-kicks an in-progress stage without creating duplicate jobs or resetting its
timeout/backoff. Only one run per location can be open (including editor-waiting) at a time.

### Remove a location

Open its workspace, then **Settings → Remove location and generated files**.
The **Settings** tab holds the same confirmation.
Read the retention summary and type the location ID to confirm. This is admin-only;
the internal-map password cannot authorize removal.

Cancel active/editor-waiting runs first, then wait for executing workers to finish.
Publication cannot be cancelled. Cleanup uses the pipeline worker lease, so an executing
worker (including another location's worker) may temporarily block removal; retry when idle.
Removal deletes the existing location-scoped pipeline records, including edition entries
linked through their owned edition IDs. It removes exact known generated edition JSON,
source snapshots, email previews and per-job logs from the **currently configured**
reader/pipeline folders. It never recursively deletes a folder or follows arbitrary stored
artifact IDs. Empty folders, untracked files and artifacts in old/unconfigured folders remain.
The Drive service account must be allowed to delete these files, not just upload them;
permission failures leave removal incomplete and retryable.

Shared configuration, geographic/library directories, shared text/detail/publication caches,
other locations, reader submissions and problem reports, subscriptions, interest, engagement
and model-usage history are retained. The geographic place remains searchable and can be
onboarded again after cleanup finishes. This is not a reader-data erasure operation.

The reader directory is rewritten before file cleanup and again before completion.
If cleanup or publication of the directory fails, the API reports **Removal incomplete**,
not success. The location and its durable cleanup manifest remain visible under Location
workspaces for **retry cleanup**; new runs, onboarding and source updates are blocked.
Retrying is safe for already removed files and records. Keep storage configuration unchanged
until cleanup finishes. Readers may see cached editions until their normal cache expires.
No live data is removed by tests; removal regressions use an isolated MongoDB and local fixtures.

## Neighborhood and community coverage

Enter a US neighborhood/community and its city/state, then press **Search all communities**
or Enter. Photon/OpenStreetMap resolves places beyond any checked-in catalog, for example
`Wallingford, Seattle, Washington`. Select the matching result and add it. Results depend
on the provider's mapped places and spelling: no geographic directory guarantees every
informal community. Typing alone searches the local Census directory, optional reviewed
overrides and previously resolved places; it never sends autocomplete requests upstream.
`Freemont` remains an alias for the optional Fremont override.

Each provider place has a stable OSM-based ID, separate run history, source settings,
link cache and reader interest signup. Onboarding reads the saved
provider record, not client-supplied coordinates. Existing Census city editions and IDs
are unchanged. Reader autocomplete includes saved communities without upstream geocoder
requests; an explicit **Search all communities** can query the provider. No catalog
entry or matching Census parent row is required.

**Location resolved is not sources ready.** Source discovery runs independently; missing
branches, websites, supported government platforms and community feeds are visible gaps,
not a reason to reject a valid place. Location cards and the **Settings** tab report `ready`,
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

The saved location profile records coverage terms, selected branches, feed configuration,
area uncertainty and discovery gaps. The **Settings** tab shows library systems, source
coverage and gaps; the administrator-only location read API returns the full profile.
Additional validated publisher RSS/Atom feeds can be added as website/feed sources under
**Sources → Add a source**.
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

### Source map and discovery

Onboarded locations and source inventory live in MongoDB, with optional reviewed community
overrides and connector defaults rather than an exhaustive checked-in source list.
Each location has a **source map**
(`source_map`, one record per source: reader, parameters, section, how it was found, health,
editor status and an optional window override). At the start of a run, each discovery
method that is due runs as its own job, then `plan_sources` turns the map into collection
tasks. A failed method keeps what it found before and retries after an hour.

The methods below make up the **fixed pipeline**, one list of readers in
`discovery/methods.ts` (`FIXED_READERS`): city and county, open data, schools, local groups, local
institutions, news and wider sources, and home sales. Every page a fixed reader adds goes through
`evaluateLeads`, with the same check groups and evidence facts as a search result; structured
sources (datasets, meeting-system accounts, CivicPlus feeds, national readers, ATTOM) keep their
own checks. Each method's finds are counted per category, and the run funnel on the source map
page shows what the fixed pipeline found in each of the ten categories. Model suggestions
(`llm`) and the Seattle-only `directories` method no longer run: the agent replaces them.

| Method | Finds | Refresh |
| --- | --- | --- |
| `government` | The city's checked website (location profile, OpenStreetMap, its Wikidata item) and the county's (OpenStreetMap Nominatim), their CivicPlus feeds (news, calendar, agendas, alerts) and Agenda Center. Reads hub pages for category pages (agendas, hearings, boards, police and fire, permits, business, parks, events, volunteering), plus linked meeting portals and the chambers and community groups they list. The home pages, the Agenda Center and every category page are put through the same checks as a search result | 30 days |
| `institutions` | Libraries, police and fire stations and community centres inside the area, and the clubs and high schools serving it from just outside, read in depth like a school's site (at most 8 sites, 6 pages each), so their events, news and notices pages become sources. Every other place with a website on OpenStreetMap inside the area (town halls, courts, venues, museums, markets, newspapers, nonprofits, parks) has its home page checked; schools and funeral homes are left to `schools` and `groups`. At most 15 places per section, 2 per host, 60 in all (Overpass, with mirrors) | 30 days |
| `meetings` | Legistar, CivicClerk and PrimeGov accounts for the city and county, by name | 30 days |
| `opendata` | Socrata portals for the city, county and state (found by catalogue search and `data.<name>.gov`) and their police, fire, permit, inspection, licence and 311 datasets with a date column and a location or city column | 14 days |
| `newsrooms` | Wikidata outlets published within 25 km with a current feed, each site checked like any other page (its Wikidata feed tried first) | 14 days |
| `athletics` | The state's school athletic association (Wikidata), its site checked like any other page, covering the state | 30 days |
| `schools` | The school districts covering the place (Census geocoder, then the NCES directory for their websites), their board meetings, calendars, news and hosted board portals, and local schools' PTA, PTSA or PTO pages | 30 days |
| `groups` | Chambers, downtown, visitor and neighbourhood groups at their usual addresses, kept only if the page says what it is, names the place and passes every check; funeral homes' obituary pages | 30 days |
| `publishers` | Outlets news search found covering the place 2+ times (`news_publishers`), each site checked like any other page | 7 days |
| `national` | NWS, USGS, EPA, Census, Justice Department, Wikipedia, Bluesky, library systems, the city's meetings, news search, reader stories, family notices | 7 days |
| `homesales` | ATTOM sale prices for the place's postal code, only when `NEWSBEE_ATTOM_API_KEY` is set. Collection calls ATTOM only in runs that tick it | 30 days |
| `agent` | Agentic runs only, as `agent_round` jobs after the methods above: the goal-driven mapping agent (`pipeline/agent/map-sources.ts`), with search (dorking, Exa, Tavily), Tavily site exploration, page opening and proposing as its tools. Saved as `proposed` | Every agentic run |
| `review_map` | Every map run, after all the routes above: the final review. Flags likely duplicates (the model confirms what code finds) and marks each new source strong, usable or weak. Adds `review_flags` only | Every map run |

Every method's finds, and the agent's, are saved through the shared Model check
(`pipeline/discovery/gemini-check.ts`; see [the model check](../../README.md#the-model-check-the-final-review-and-saving)):
Accept or Reject with a reason code and evidence, every source judged, a model check rejection saved as a
`rejected` row a person can overrule, and anything not judged saved as `proposed` with a note.
While `NEWSBEE_PROPOSED_UNTIL_APPROVED` is on (the default, for the testing phase), every source a
map run finds is saved as `proposed`, the fixed pipeline's too, and editions read only what a person
accepted. A find never changes a source already on the map that a person labelled, or one that is
active, pinned, paused or dormant. Editors pin (always read, ranked higher), pause, reject (never rediscovered) or add sources
in the location's **Sources** tab; readers suggest
sources on the reader site, and an approved suggestion joins the map pinned.
A source with nothing for 3 runs, or failing 3
runs in a row, goes **dormant** and is retried every 14 days. `discovered_sources` still
caches area facts, newsrooms, athletics and topics; `discovery_state` records each method's
last result.

To discover another community, use the search UI. Reader search reads the same
`locations` and saved geographic/Census collections. A community can be searched and
receive interest signups before publication; only published locations appear in the
Drive-backed edition picker.

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
sources are added as editor source links, not broader citywide scraping. Feed discovery
uses the existing public-HTTPS/robots/DNS/redirect protections and validates feed format.

To remove an onboarded community or town, open its workspace's **Settings** tab, choose
**Remove** and confirm. Removal is blocked while a
job is running or a run is active, including an editor-waiting run; cancel that run first.
It clears the town's pipeline records and manual links and removes it from the reader
site's published-location directory.

### Moving a site between stacks

The **Import & export** page (`/site-backup`) is available to every signed-in,
approved journalist and downloads and restores one
versioned JSON archive. It includes every non-system MongoDB collection (with BSON
types preserved) and files under the configured reader and pipeline artifact roots.
Binary artifact contents are Base64-encoded in the archive. Local-drive extras are
preserved when exporting from a local stack. The archive is limited to 250 MB and
imports validate its format and content before replacing any data.

Import replaces the destination's non-system collections and files in its configured
Newsbee artifact roots. Back up the destination first; replacement is destructive and
cannot be rolled back. Any signed-in, approved journalist can use the page and API;
import requires typing `REPLACE ALL SITE DATA`.

Archives intentionally exclude environment variables and secrets (including MongoDB
credentials, API keys, OAuth settings and Google service-account credentials), external
account permissions, and external services. Configure those separately on the new
stack. For cloud imports, configure the destination's reader and pipeline Drive folders
and grant the destination service account access. Treat archives as sensitive because
they can contain unpublished editorial content and personal data.

### Reader publishing

Every journalist can create and manage multiple **Publishing channels** (`/publishing`), with a
dedicated workspace at `/publishing/<channel-id>`. Each channel can target the Reader-site/edition
feed, video publishing, or both, with an optional URL for each destination and a searchable selection
of locations. In a channel workspace, each edition can use Reader mode, Video generation, or both.
Journalists select published stories from the channel's locations and can mark individual stories
for video generation while also including them in the Reader edition. Reader-compatible editions are
saved to the channel's Drive folder. Video selections open the existing YouTube process for package review, video generation,
visibility, playlist selection, and upload. YouTube upload settings are managed per location in video
story management.

New location editions and corrections are also sent to enabled channels with a Reader-site destination
that includes the edition's location. Saving a channel copies the latest published edition for newly
selected locations. Channels are scoped to the signed-in journalist and stored in the `output_channels`
collection; curated channel editions are stored in `output_channel_editions`. A Reader-site channel's
feed-folder ID is shown in its settings for configuring the destination reader.

Publishing also writes each edition to the default reader folder and rewrites that folder's
`locations.json` to list every onboarded location with a published edition. Both services
first resolve the `output_channels` document selected by `NEWSBEE_OUTPUT_CHANNEL_ID`
(default `reader-site`), requiring `enabled: true` and a valid `drive_folder_id`.
Only an absent document falls back to `NEWSBEE_READER_DRIVE_FOLDER_ID` (default
`1S2uePphOd_25yandeFtQJ6iZvSz2ydYw`). Disabled/malformed channels and database/configuration
errors fail closed. Journalist-owned publishing channels remain separate and unchanged.
Cleanup and backups use the same resolved folder; restore resolves the archived channel
before replacing artifacts. In local mode, the folder of that name is under
`.local/stage2/drive`. Removing a location rewrites the directory; its stored edition
files are kept but no longer served. Withdrawing or restoring a story republishes the
location's latest edition to the default reader and any selected output channels.

## Limits

Count limits belong to the `caps` rule group, which is **off by default**: every source on the
map is read, every item a reader finds is kept, and every section prints every story that passes
the editorial checks. Turn caps back on for one run on the kick-off panel, or for every run with
`NEWSBEE_GUARDRAILS_OFF=none` (or any list of groups without `caps`). With caps on, these apply:

| Limit | With caps on | Where |
| --- | --- | --- |
| Items rated, candidates and stories printed per section | 30, 20, 10 | `limits()` in `pipeline/core/run-options.ts` |
| Items per source per section; city-wide items per edition | 5; 3 | `limits()` |
| Website reads per site: requests, pages, items | 10, 5, 25 | `limits()` |
| New web sources per host; proposals per host; section pages per host | 2; 12; 24 | `limits()`, `PROPOSED_PER_HOST` and `SECTION_PAGES_PER_HOST` in `pipeline/sourcemap/store.ts` |
| OpenStreetMap places per location; per section; per host | 60; 15; 2 | `general.stop.osm_cap`, `osm_section_cap`, `osm_per_host` in the playbook, through `itemCap()` |
| Items per reader: home safety, justice, neighbours, open data, property, remembrance, earthquakes, Wikipedia, trends | 5, 6, 6, 25, 40, 8, 5, 5, 5 | `MAX_ITEMS` in each connector, through `itemCap()` |
| Pages per paged API: Justice Department, BiblioCommons | 20, 5 | `MAX_PAGES` in each connector, through `itemCap()` |
| Stories per run | Off unless set | **Story limit** on the kick-off panel |

These stay on whatever the caps setting, because they keep a run safe or inside its time:

| Limit | Value | Where |
| --- | --- | --- |
| Time per source, collection and run | `SOURCE_BUDGET_MS`, `NEWSBEE_COLLECT_BUDGET_MINUTES`, `NEWSBEE_RUN_TIMEOUT_MINUTES` | `pipeline/orchestration/orchestrator.ts`, `pipeline/core/config.ts` |
| Bytes per feed or page | `MAX_FEED_BYTES` | `pipeline/connectors/common.ts` |
| Model calls per day for extraction and discovery | `NEWSBEE_MODEL_DAILY_CALLS` | `pipeline/model/budget.ts` |
| Paid calls per run | `NEWSBEE_PAID_BUDGETS` | `pipeline/trace/gateway.ts` |
| Feed probes per site at discovery; meeting document pages; agenda items in a meeting summary | 4; 3; 5 | `discovery/feeds.ts`, `connectors/meetings/documents.ts`, `connectors/meetings/meetings.ts` |
| Items per source on the public edition map | 60 | `MAX_ITEMS_PER_SOURCE` in `pipeline/editions/edition-map.ts` |
| Sites never fetched: social platforms, plus publishers whose terms forbid automated or AI use (Seattle Times, KUOW, MyNorthwest) | | `DO_NOT_SCRAPE` in `pipeline/connectors/fetcher.ts` |
| Discovery's other limits: pages read per site and section, school districts and schools, funeral homes, open-data portals, publishers, Gemini suggestions, institutions, agent rounds | | The `*.stop.*` rules in the playbook |

The playbook (`playbook/` at the repository root; `playbook/rules-overview.html` lists every rule) holds discovery's
rules and limits. Only the OpenStreetMap limits above follow the caps setting; the rest stay on, because several
are thresholds rather than counts. To raise one, change its value in the playbook, run `npm run playbook` in
`apps/journalist-site` and commit the result: a production build fails while the compiled copy is out of date.

### Source log

Besides the JSON log records, the server log (Vercel Logs, or the terminal locally) prints
readable tables of every source with its newsletter section (`pipeline/orchestration/source-log.ts`):

- `=== Newsbee sources: <location>: <discovery method>, N found, M new on the map ===` as each discovery method finishes;
- `=== Newsbee sources: run <id> for <location>, N of M sources on the map read ===` when a run plans collection, listing every source on the map, how it was found and why any is not read;
- one `[newsbee:source] <location> | <section> | <source> | <status> | N items kept, M left out | <url> | <detail>` line as each source finishes.

## Model providers

Local runs use Ollama by default. To call hosted LLM APIs instead (locally or in the cloud),
list providers in fallback order in `NEWSBEE_MODEL_PROVIDERS`; if a call fails with a
provider or network error, the same call is retried on the next provider.

| Provider | Variables |
| --- | --- |
| `gemini` | `NEWSBEE_GEMINI_API_KEY`, `NEWSBEE_GEMINI_MODEL` (default `gemini-flash-latest`), `NEWSBEE_GEMINI_LIGHT_MODEL` (its light model, default `gemini-flash-lite-latest`) |
| `ollama` (local only) | `NEWSBEE_OLLAMA_URL`, `NEWSBEE_OLLAMA_MODEL` (default `qwen3:4b`) |
| Any other name, e.g. `openai`, `groq`, `azure`: an OpenAI-compatible API | `NEWSBEE_LLM_<NAME>_BASE_URL` (default for `openai`: `https://api.openai.com/v1`), `_MODEL`, `_API_KEY`; optional `_AUTH_HEADER` (`api-key` for Azure), `_MAX_TOKENS_PARAM` (`max_completion_tokens` for newer OpenAI models), `_TEMPERATURE` (default `0`; `default` omits it), `_LIGHT_MODEL` (its light model; unset, light work uses `_MODEL`). If a model rejects either one, the adapter switches to `max_completion_tokens` or omits `temperature` and retries automatically, `_JSON_MODE` (`json_object` if the API lacks JSON schema output) |

Nothing in the pipeline assumes Gemini. Every model call (writing, ranking, extraction,
discovery, the mapping agent and the model check on every source) goes to the configured
providers in order, falling back down the list. Light work (extraction, discovery, the agent's
planning and the model check) tries each provider's light model before its main model: a Gemini
provider's light model is `NEWSBEE_GEMINI_LIGHT_MODEL`, and another provider's is
`NEWSBEE_LLM_<NAME>_LIGHT_MODEL` (unset, it uses its main model). In a personal profile each provider
has its own Light model field; the profile's default light model applies only to Gemini providers.
On Gemini's free tier the main model allows only about 20 calls a day, so its light model matters
there. Every Gemini call, on either model, also counts against Gemini's own hard limits (see
[Hard limits](../../README.md#hard-limits-for-free-tier-testing)); other providers have none.

All hosted model calls share one paid budget, **Model calls** (`model`), whichever provider
serves them; the agent's planning keeps its own **Agent model** budget. Runs saved with the
old separate Gemini (`gemini`) and OpenAI-compatible (`openai_compatible`) budgets read the
larger as their model budget, and `gemini` or `openai_compatible` in `NEWSBEE_PAID_ALLOW` and
`NEWSBEE_PAID_BUDGETS` mean `model`.

Web-grounded search (the optional model news search, `NEWSBEE_NEWS_SEARCH=llm`, and model source
suggestions) needs a model that can search the web. It uses the first configured provider that
can: today a Gemini provider (Google Search grounding), on its light model. Other providers have
no standard grounded search, so they are passed over; with none, the step is skipped.

Example: `NEWSBEE_MODEL_PROVIDERS=gemini,openai`, `NEWSBEE_GEMINI_API_KEY=...`,
`NEWSBEE_LLM_OPENAI_MODEL=gpt-4.1-mini`, `NEWSBEE_LLM_OPENAI_API_KEY=...`. Cloud mode
defaults to `gemini` and rejects `ollama`. **System** shows each provider's status; health
is failed when none can serve requests and warning when running on a fallback.
Every generation attempt is recorded (35-day retention), including failures and fallbacks.
**System → Model usage** shows calls, reported input/output tokens, estimated cost and coverage by
actual provider/model, location, pipeline role and UTC day. Plain and structured generations
retain provider token metadata; output includes separately reported reasoning tokens (such as Gemini's thoughts).
Each run uses the models of the person who started it, so **Model usage** also shows usage
**by person** (whose keys paid, with the models each used) and **by run** (the latest 50 runs,
each with the models that served it, who started it and whether it ran on their own keys or the
deployment defaults). **System → Pipeline** shows a Models by run panel for the last 7 days' runs.
Pipeline jobs attach location/run context safely across concurrent workers. Manual discovery
attaches location context. Older calls without context remain **Unassigned / historical**.
No prompts or generated text are stored in usage accounting.

Set both `NEWSBEE_MODEL_<NAME>_INPUT_COST_PER_MTOK` and `_OUTPUT_COST_PER_MTOK`
(USD per million tokens) for the currently configured model. A provider's light model has its
own `NEWSBEE_MODEL_<NAME>_LIGHT_*` prices (for example `GEMINI_LIGHT`), never the main model's rates. `_RPM_LIMIT`
and `_RPD_LIMIT` remain optional quota references (for example
`NEWSBEE_MODEL_GEMINI_RPM_LIMIT=15`). For exact historical/other models, set
`NEWSBEE_MODEL_PRICING` to a JSON array with `provider`, `model`, `input_per_mtok` and
`output_per_mtok`; see [deployment](../../Docs/deployment.md#model-usage-pricing).
Unknown prices/token counts are excluded from the **priced subtotal**, never treated as
free. Both rates must be configured; explicit zero rates are supported. These estimates
apply current configured prices to history, not historical price snapshots or provider bills.
Hosted structured calls reserve at least 4,096 tokens for reasoning and output; story-length
limits and publication validation remain unchanged.

Ranking prefers the configured **hosted providers only**, in their listed order, whenever
any are configured; it does not silently spill the workload onto Ollama. No new API
key is needed if Gemini/Groq is already configured. Ollama-only configuration remains
available. Authoring stages up to twenty candidates per section and publishes up to
ten passing stories per section. Hosted APIs may impose rate limits or
charges; a free tier is not an unlimited quota.

## Test

```text
npm run lint        # tsc --noEmit
npm test            # Vitest unit and isolated MongoDB-backed regression tests
npm run build       # production Next.js build and type validation
```

The suite covers model/provider accounting and concurrency, writing/ranking checks,
reader boundaries and usage aggregation, password-only map/admin isolation, deployment
routing, connector contracts and storage. MongoDB-backed tests create isolated databases;
the first run may download a MongoDB binary. For a focused check:

```text
npm test -- pipeline/tests/workspace/internal-access.test.ts pipeline/tests/workspace/usage.test.ts pipeline/tests/model/usage.test.ts
```

These are not live-provider or full browser end-to-end tests. Use the run inspector,
item traces and alerts in preprod, and inspect a real published edition before a production
release. Local sample-data previews verify presentation and access boundaries, not live
source coverage, real model output, billing or cloud credentials.

## How a run works

One open run per location, of two kinds that share the job queue and never start each other:

- A **map run** (**Refresh source map**) only writes the source map: `discover` jobs, `agent_round` jobs when the source map method is agentic, then `finish_map`, which saves each meeting and library source's working address. It stops at `mapped`.
- An **edition run** (**Collect stories**) only reads the map. A saved address that fails is marked `needs_remap` for the next map run, with no searching and no link-picking model calls. A location with no sources is refused with "Build the source map first".

Each bounded step is a durable job in MongoDB `pipeline_jobs`, sized for one Vercel function call. The run inspector tracks five edition phases separately: collect source items, filter/merge/assemble, enrich/rank candidates, extract details/write stories, and build the edition front page/email. The individual planning, source, section-ranking, story-writing and finish jobs retain their status, attempts, timestamps, errors and logs; the edition funnel links each stage to item-level decisions and reasons. The worker still has three control phases (`collecting`, `authoring`, `finishing`), recorded in `stage_transitions`; under **autopilot** they follow on automatically, while **manual** mode pauses at the authoring and finish checkpoints for an editor click. Cloud admin triggers publish wake-ups to Vercel Queues; the private `/api/pipeline/queue` consumer executes one job per delivery, then starts a worker for each free slot with work ready (`pipeline/orchestration/dispatch.ts`). Retries and interrupted workers use one delayed delivery. No cron, self-HTTP calls or `CRON_SECRET` are needed for portal-started cloud stages. Locally, admin triggers use `/api/pipeline/advance` with short-lived tokens signed with `AUTH_SECRET`, and `npm run local` supplies that secret automatically. Configure it yourself when using `npm run dev` directly.

Jobs run in **worker slots**, `NEWSBEE_COLLECT_CONCURRENCY` at once (default 3 in the cloud, 6 locally). Sources and discovery methods overlap; agent jobs, planning and authoring go one at a time within a run. Editions come before map runs, then the oldest run first, and spare slots go to the next run. A run waiting for an editor holds no slot.

Each source stops starting new requests after 60 s and keeps what it has (`partial`). Collection moves on to writing after `NEWSBEE_COLLECT_BUDGET_MINUTES` (default 8, from when its first source starts), marking sources it didn't reach as `not_reached`. Job logs stay in MongoDB for 14 days, with one file per stage saved to the artifact store.

1. **Collection** (**Collect stories**, per location or all locations): `plan_sources`, then one
   `collect_source` job per source on the map, the quickest and most useful first (active, pinned, and dormant ones due a retry). Each reader reads its source
   over its window and keeps every item, recording what it left out and why
   (`collected_items`). Failed sources are retried, then recorded without blocking the
   others. The run passes through `awaiting_authoring`.

   The **agentic flow** adds these steps, the first two in map runs and sweeps in editions, and
   everything from authoring onward is shared:
   - `agent_round` jobs (`pipeline/agent/map-sources.ts`) run the mapping agent, a researcher
     with tools working towards one goal: every category has a source the model check accepted,
     or a record of what was tried. It starts from what the fixed pipeline found, after the model
     check, as a live checklist, and works one step at a time: it picks a tool, says why, sees
     the result and chooses again. There is no set number of steps, searches, results opened or
     pages judged. Its tools: **search** with dorking (Bright Data or SerpApi; SearchApi isn't
     used), Exa (meaning-based) or Tavily (AI search), whichever the run enables, with the agent
     writing the query and code setting results per search, US region and English, a date range
     where it helps, and leaving out the platforms we never read (subject to Access); **explore**
     a confirmed site with Tavily from an instruction (2 a run); **open** a page through our
     reader (`openPage` in `discovery/evaluate.ts`: the free fetcher, then Jina, then the run's
     paid fallback, Bright Data's Web Unlocker in agent runs); **propose** a source, the only way
     it saves anything, which runs the code checks on the live page and then the shared model
     check; and **not_found**, allowed once a category has had 8 searches across 2 tools. The
     query checks stay in code: local only, no guessed `site:` addresses, no admin, login or
     exposed-file queries. It stops when every category is covered or not found and the last 10
     steps found nothing new, or at a ceiling: Gemini's limits, the run's model budget or 45
     minutes, recorded as a `stopped` decision. A tool that reaches its own limit only becomes
     unavailable. Progress is saved after every step in `agent_state`, and each job stops
     starting steps 60 seconds before its 200 seconds are up, so one session carries on across
     jobs. Every step is a decision with stage `agent` (action, tool, query or page, the agent's
     reason, the result), and every source keeps the tool, query and step that found it and the
     reader that opened it in `found_by`. Its instructions are `skills/map-sources/SKILL.md` and
     the playbook's agent prompt, tool practices and research habits, starting with the directory
     habit. The agent has no database access, and page text is data. Planning and the model check
     use the light model, as separate calls.
   - A rejected key (HTTP 401 or 403) stops further calls to that service for the run, and the
     funnel shows failed searches apart from those that ran.
   - New sources are saved as `proposed`, with evidence, source tier, an access record and the
     Model check's verdict. While `NEWSBEE_PROPOSED_UNTIL_APPROVED` is on (the default, for the
     testing phase), no edition reads a proposed source until a person accepts it; with it off,
     agentic runs read them and current runs stay a clean baseline. To let editions read one,
     **Accept** it (or **Activate** it) on the source map.
   - `review_map` (`pipeline/discovery/final-review.ts`) is the final review, after every route:
     likely duplicates and each new source's strength, as flags only.
   - `sweep` tasks (`pipeline/connectors/sweep`) run `after:` queries per topic, trace secondary
     stories to original records, and propose useful new sites back to the map.
   - Agent extraction (`pipeline/agent/extract.ts`) reads pages the readers can't parse. Each
     item needs a verbatim quote found in the page, or it is dropped. The web reader does this
     for at most two pages per site per run.
2. **Authoring**: `author_start` assembles the pool: locality checks for items not
   already placed (name, alias, landmark, geocoded address, then the article text; up to
   40 geocodes and 20 articles), merging copies of one story, the no-repeat ledger, and
   sections. Then one `author_rank` job per section: rules order the section, bounded
   evidence gathering enriches its top 30, the model rates them using source passages
   rather than just feed teasers, and the v5 pass refines them; when all sections are ranked, the top
   **20 per section** become candidates (at most 5 per source per section, at most 3
   city-wide items). `author_story` writes one candidate per job: details extraction with
   the light model (cached, within the daily cap; otherwise rule details), the writing
   floor, the writer with one validation retry. A section stops once **10 stories** pass.
   Across the eleven sections this permits up to 110 stories, not a required fill count:
   local relevance, diversity, withdrawals, validation and model budgets still apply.
   The reader's **All stories** view includes every published item even when it is not
   in the top five, a topic preview or the edition's seven-day event grid.
   Home sales, permits, scores and death notices print as compact digest entries from their
   source facts, with no model call. Exploration raises the limits above, keeps and flags items
   that fail a check, and records the rule on each.
   The run passes through `awaiting_finish`.
3. **Build**: the strongest story leads; the front page and email preview are written; the
   edition and its **edition map** (`edition_maps`) are saved, and the run ends `built` (**Ready to
   publish**), freeing the newsroom slot. Nothing reaches the reader. Email is preview-only: **no
   email is sent**.
4. **Publish** (a person, any time later; `POST /api/admin/locations/{id}/editions/{edition}/publish`):
   the edition is written to the reader folder and the run becomes `published`. The first time,
   the edition also enters the no-repeat ledger and the source map's published counts. Runs with
   **Count toward history** off are published without entering the ledger or edition window.
   Publishing an earlier edition again makes it live again. A story can be withdrawn from a built
   edition before it is published, or from a published one after.

### Run options and the decision record

Each run saves its options (`pipeline/core/run-options.ts`) and reads them through an async
context, so the fetcher, the gateway, the floor and the assembler see the same choices. See
[Run options](../../README.md#run-options) for every setting.

| Collection | Holds |
| --- | --- |
| `pipeline_runs` | `options`, and `source_snapshot`: the sources as they stood when the run planned collection |
| `source_map` | Adds status `proposed`, `source_tier`, `evidence`, `access`, `why`, `topics`, `access_overrides`, `checks` (discovery's locality and freshness facts, each with a `pass`, `fail` or `unclear` outcome), `gemini` (the model check's verdict, reason code, evidence, or why it wasn't judged, and the details it judged), `recent_titles` and `review_flags` (the final review's strength and likely duplicate); `found_by.query` holds the exact query |
| `collected_items` | Adds `would_have_blocked` and `access_overrides`; `facts` adds `source_tier`, `topic` and `found_by_query` |
| `run_decisions` | The decision log: stage, actor (`rule`, `model`, `classifier`, `agent`, `provider`, `reader`), subject, decision, reason and evidence. No expiry |
| `search_queries` | Each query, its topic and results, and the sources it led to. Results are reused for 7 days, so a repeat doesn't pay twice |
| `api_calls` | Each external and paid call or skip, with estimated cost |
| `run_budgets` | Each run's paid budget counts, the hard-limit counts (per run, hour, Pacific day, month and in total), call pacing, and the hard limit that stopped a run (`stop:<run>`) |
| `agent_state` | The mapping agent's session per run: checklist, every step, the sources it proposed, unavailable tools |

The source map's run funnel (`pipeline/trace/funnel.ts`) reads these. Runs from before this record
fall back to their saved `edition_maps`, and what was never recorded is labelled, not estimated.
Routes: `GET /api/maps/locations/<id>/runs`, `GET /api/maps/locations/<id>/runs/<run>/funnel`
(with `?stage=` or `?item=`), `GET /api/admin/runs/<run>/decisions`,
`GET /api/admin/runs/<run>/api-calls`, `GET /api/admin/run-options`,
`DELETE /api/admin/relaxed-content`, and `POST /api/agent-tools` (local only, for a harness).

The run list/detail and the Dashboard show both waiting states. Authenticated same-origin admin
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

**Location management** shows pipeline progress and published/held counts for every
location; open a location for its run history and **Inspect run** for each source, story
(with held reasons) and job. A failed or interrupted job can be retried on its own with
**Retry failed step only**, keeping completed jobs and authored work. Each cloud source collection runs in
its own authenticated Vercel function invocation; structured per-attempt JSON-line logs
are stored under `.newsbee-pipeline/logs/<run-id>` beneath the configured Drive folder
and are available from each job in **Inspect run**. **System** shows current providers,
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

### Source evidence before selection

`pipeline/editions/evidence.ts` separates evidence retrieval from model extraction.
Before final section ranking it reads the shortlisted articles even when the light
model is unavailable or the daily model-call cap is exhausted. It considers every
candidate's first source before second sources, with at most **20 new document reads
per section, 4 per host, 2 sources per story**, and a 45-second admission window
(an in-flight request, robots pacing, or bounded PDF decoding may finish later).
Requests time out after 5 seconds and accept at most 4 MiB. Existing public-address,
redirect, robots, rate-pacing, reuse/AI opt-out and paywall checks still apply.
Link-only sources are not enriched. One explicit same-origin agenda, staff-report,
project/application/registration-details link may supplement the article; another
already-merged reporting source takes precedence. There is no recursive crawl.
HTML and text PDFs are supported, reusing the meeting reader's maximum 12 PDF pages;
scans without text and unsupported documents are reported, not invented or OCR'd.

Reuse-checked text has a 24-hour enrichment freshness limit (30-day storage TTL).
The packet retains source/final URLs, retrieval time, a content hash and verbatim
passages selected from up to 12,000 characters, favoring useful later details such as
deadlines and costs instead of only a prefix. Ranking uses up to 600 characters;
extraction/writing use up to 6,000 characters of selected evidence. These are bounded
evidence windows, not copies of external articles for publication.

Light-model extraction still obeys the daily call cap. Extracted fact values must be
verbatim in supporting source passages; unsupported values are discarded. Invalid or
truncated model responses are reported, and provider quota errors retain worker
backoff. Cached details are keyed by content as well as policy, so changed evidence
cannot silently reuse old facts. Raw evidence can support writing without an extraction
call; it is withheld when new evidence triggers the names/address/suicide floor.
Existing output-length limits and publication checks are unchanged.

Open an **item trace → Source evidence** to inspect fetched/cached/blocked/failed/
unsupported/budget-limited documents, passages, extraction outcomes, and fields not
established in structured details. Text volume is explicitly not a factual-quality
score; these diagnostics do not guarantee source accuracy or factual entailment.
Evidence remains in the admin trace, not public articles or internal-map snapshots.

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

## Readers and source links

The reader registry (`pipeline/connectors/registry.ts`) lists one reader per kind of
source; each knows its window, story kinds and default ranking. Which sources a location
has lives in the source map.

| Reader | Reads | Window |
| --- | --- | --- |
| `web` | Any website on the map: its feed (on record, advertised or a common path), iCal links, schema.org events and articles, recent sitemap pages, story-like links, and each page's title, date, description, authors, image and main text; 10 requests per site; full text kept 30 days (`item_texts`) for details and locality, never republished | News since the last edition (up to 14 days); events 14 days ahead |
| `opendata` | Any Socrata dataset on the map, columns read from the dataset's own metadata; police and fire calls grouped into incidents (same block within 2 hours) with plain-word call types, block-level places, unit counts and outcomes, notable ones as stories and the rest in one summary; permits (block level), licence applications, inspections; 311 as one summary. Personal columns are never selected | Calls 7 days; records 21 days |
| `newssearch` | GDELT DOC API, three topic searches per place (`NEWSBEE_NEWS_SEARCH`, default `gdelt`; `llm` adds web-grounded model search, on the first configured model that can search the web). Google News RSS is not used (its robots.txt disallows `/rss`) | Since the last edition (up to 14 days) |
| `library`, `meetings`, `hazards`, `trending`, `homesafety`, `housing`, `justice`, `community`, `remembrance` | Library calendars, Legistar/CivicClerk meetings, NWS and USGS, Wikipedia and Bluesky, EPA water records, Census permits, Justice Department releases, reader stories, family notices | Per reader |

**Source links.** Under **Sources → Add a source**, add a website or feed (with its section,
and whether the organisation is inside the area), an open-data dataset (with its topic), a
meeting platform or a library catalogue. The link is read once with its reader before it is
saved; unusable links are rejected. Funeral-home sites need a note recording the
republication permission. Earlier editor links were moved onto the map on the first run.

**Crawling guardrails** (`connectors/fetcher.ts`, `connectors/web/page.ts`): public data APIs
skip robots.txt; websites are robots-checked, sites that opt out of AI crawlers are skipped,
crawl-delay is honoured up to 10 s (`general.stop.max_crawl_delay`; a wait that wouldn't fit in the job's time makes the page a link-only lead instead), one page at a time is read per host and requests to it are
paced (at least 1 s, from the playbook), 3 "slow down" answers stop a host for the job, login
redirects and 401/403 are skipped, pages marked `noindex`/`noai` or with a mining reservation
are skipped, `nosnippet`/paywalled pages keep only the headline and link, and the never-read list
(Facebook, Nextdoor, Instagram, X, Reddit, TikTok and Legacy.com) isn't fetched. Robots, AI
opt-outs, `noai`, `nosnippet`, terms and the never-read list are the Access group, which a
relaxed local run may skip; crawl delays and the private-address check never are.

**Lookup windows and repeats.** News-like sources read since the last edition, capped per
type (news 14 days, calls 7, records 21, meeting minutes 35); events and meeting previews
read 14 days ahead. The ledger (`published_stories`) records each printed story's merge
group and distinctive tokens: a later copy with nothing new is dropped, one with 2+ new
facts is printed as an update; events print at most twice (first mention, then a "this
week" reminder) and a recurring event at most once every 4 weeks.

**Details and the floor.** Before writing, the light model extracts each story's people,
organisations, places, numbers, what happened, a short quote and the next step from its
text (names and quotes are checked against the text). The writer leads with them. The floor
(`editorial/floor.ts`): allegations stay allegations; no names of minors who are suspects,
defendants or victims, or of sexual-assault or domestic-violence victims (withheld from the
writer and checked in the draft); no house numbers (block level); suicide reported without
method details and with the 988 line. Crime, arrests, deaths and court cases are otherwise
ordinary stories, and students may be named in a positive light. Only private matters
(tenancy, benefits, personnel) are held before writing.

**Story kinds** are defined once in `pipeline/editorial/kinds.ts`; sections in
`pipeline/sourcemap/sections.ts`.

### Ranking (v5) and voice

Within each section, after rules order it and the model rates its top 30 (`model/newsworthiness.ts`), `ranking/edition-ranker.ts`:
1. multiplies each score by a per-community, per-category Thompson-sampling draw learned
   from anonymous reader views, article opens (historically source opens) and shares (`reader_engagement`), with a prior
   pooled across communities; categories with no reader data are left unchanged;
2. asks the model once to order the top ten as an editor would, adding a Borda bonus
   (no bonus if that call fails);
3. reorders by maximal marginal relevance so similar stories (same category, source or
   title) are spread out.

Each story's breakdown appears in run inspection's **Why ranked** column.
`NEWSBEE_RANKING=classic` uses the model ratings alone.

`model/voice.ts` sets the writing voice (`NEWSBEE_VOICE`: `plain`, `lively` (default) or
`bold`). Court cases, deaths, safety notices, weather alerts and earthquakes are always
plain. On top of the existing fact checks, drafts are rejected for clickbait phrases,
numbers or superlatives not in the source, all-caps shouting or too many exclamation marks.

## Cloud configuration (Vercel)

| Variable | Purpose |
| --- | --- |
| `NEWSBEE_MODE=cloud` | Use Drive and require Google administrator sign-in for the workspace; reader pages and password-only maps remain independently reachable |
| `MONGODB_URI`, `MONGODB_DATABASE` | MongoDB Atlas |
| `NEWSBEE_MODEL_PROVIDERS` plus each provider's variables (see Model providers) | LLM APIs, in fallback order |
| `NEWSBEE_VOICE` (optional) | Writing voice: `plain`, `lively` (default) or `bold`. Court, death and safety stories are always plain |
| `NEWSBEE_RANKING` (optional) | `v5` (default: engagement bandit, editor pass and variety) or `classic` (model ratings only) |
| `NEWSBEE_ARTIFACT_STORE=mongo` (optional) | Keep editions and run artifacts in the MongoDB `artifacts` collection instead of Google Drive, for accounts without a Shared drive. Set it on both services; the Drive variables below are then not needed |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Drive writer key; use JSON to keep it distinct from the reader's email/private-key variables in the shared project |
| `NEWSBEE_PIPELINE_DRIVE_FOLDER_ID` | Existing Shared Drive folder for run artifacts |
| `NEWSBEE_OUTPUT_CHANNEL_ID` | Shared Reader `output_channels` document ID; defaults to `reader-site`; existing documents must be enabled and valid |
| `NEWSBEE_READER_DRIVE_FOLDER_ID` | Reader-folder fallback only when the selected channel is absent; defaults to `1S2uePphOd_25yandeFtQJ6iZvSz2ydYw` |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` | Google sign-in (redirect URI `https://<host>/api/auth/callback/google`) |
| `NEWSBEE_INTERNAL_PASSWORD` | Required to enable both read-only maps and `/api/maps/*`; independent of administrator authentication, fail-closed when unset |
| `FAL_KEY` (optional) | Shared default for video generation; the owner may override it in Environment & API settings |
| `NEWSBEE_MODEL_PRICING` (optional) | Exact provider/model input/output USD-per-million-token overrides; see Model providers and the deployment pricing guide |
| `NEWSBEE_MODEL_<NAME>_INPUT_COST_PER_MTOK`, `NEWSBEE_MODEL_<NAME>_OUTPUT_COST_PER_MTOK` (optional) | Both rates price the currently configured model; use separate `GEMINI_LIGHT` rates for the light model |
| `CRON_SECRET` (optional) | Authorizes optional Vercel Cron calls to `/api/pipeline/tick`; cloud stages use Vercel Queues instead |
| `NEWSBEE_RUN_TIMEOUT_MINUTES` (optional) | Fail an in-progress stage after this time, excluding editor waits (default 60, `0` disables) |
| `NEWSBEE_COLLECT_CONCURRENCY` (optional) | Jobs running at once (default 3 in the cloud, 6 locally) |
| `NEWSBEE_COLLECT_BUDGET_MINUTES` (optional) | Move on to writing after this long collecting (default 8, `0` disables) |
| `NEWSBEE_JINA_API_KEY` (optional) | A higher Jina Reader limit; it works without a key at a lower one |
| `NEWSBEE_AI_LINK_DISCOVERY` (optional) | Also let the model look for event links (off by default) |
| `NEWSBEE_READER_SITE_URL` | Full reader URL, `https://<host>/reader`; used for links in email previews |

Deploy one Vercel project from the repository root using root `vercel.json`.
The journalist service owns `/` and its existing APIs; the reader owns `/reader`.
There are no HTTP dependencies between services, so no bindings are required.
See the [deployment guide](../../Docs/deployment.md) for shared environment settings.

### Video creation

**Video creation** appears inside publishing channels with a video destination, listing published
stories for the channel's selected locations. Only owners can generate videos because YouTube
publishing uses the signed-in owner's Google account. Each video is linked to its edition, so the
edition funnel shows **Videos made** and lists them. The old `/video-studio` page sends you to
Publishing channels, optionally focused on the specified location. Videos use the signed-in owner's configured model profile to
prepare YouTube and TikTok copy, a spoken script, a fal.ai prompt, and an estimated SRT
draft. Video generation uses the deployment's `FAL_KEY` by default; the owner can override it
with a personal fal.ai key in Environment & API settings. The studio uses `minimax/h3-max/text-to-video` for 9:16 portrait
video with native audio generation and a 15-second duration. The hosted fal.ai endpoint
does not expose local ComfyUI controls such as LoRA selection or turbo steps. Review the facts and prompt
before submitting a paid generation, then check the rendered audio and edit the SRT timings
before publishing. Completed MP4s are stored under the pipeline's Google Drive
`.newsbee-pipeline/video-production` folder in cloud mode.

To upload a completed video directly to YouTube, use **Connect YouTube** in its story
management page. This requests the YouTube account-management permission from the Google
account currently signed in to the journalist app; uploads default to private, with
unlisted and public visibility available before upload. Select an available channel and
playlist; the selected playlist is remembered per location and signed-in owner. The
encrypted NextAuth session retains the user-specific refresh token. YouTube's standard
video upload endpoint uses the channel authorized by the current Google OAuth identity;
the app verifies the returned channel and warns if it differs from the selected one.
Switch Google/YouTube identity and reconnect if the desired channel is not available.
YouTube publishing uses the existing `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` settings;
enable YouTube Data API v3 for that Google Cloud OAuth project and ensure its consent
configuration allows the `youtube` scope.

### Configure Google Drive

Skip this section when `NEWSBEE_ARTIFACT_STORE=mongo` is set.


1. In Google Cloud Console, create or select a project, enable the **Google Drive API**,
   and create a service account with a JSON key.
2. Create a folder in a **Google Workspace Shared drive** for Newsbee's pipeline files.
   Service accounts cannot own new files in personal My Drive; a shared My Drive
   folder is not a Shared drive. Both Newsbee Drive adapters support Shared drives.
   Copy the folder's ID from the URL
   (`https://drive.google.com/drive/folders/<folder-id>`) and share the folder with the
   service account's `client_email`, granting write access (for example, Shared-drive
   **Content manager** membership). The same account needs
   access to the reader folder where published editions are stored.
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
in `.newsbee-pipeline/` beneath that folder. It does not create an extra app-level folder.
The reader site reads published editions from the reader folder
(channel first, environment fallback only if absent), not from the pipeline root. **Drive diagnostics**
(`/drive-diagnostics`) shows the service account and pipeline folder and can run a write
test. Drive API calls support Shared Drives, but the pipeline
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
`journalist_admins` (lowercase); the **Administrators** page adds more. Each location's sources live in
`source_map`; editor additions are validated and pinned there.

## Scraping rules

Query patterns, page words, section and tier rules, limits and each search service's operators live in the top-level `playbook/` folder, not in code. `pipeline/playbook/index.ts` reads them from `pipeline/playbook/compiled.json`, which is imported, so it is in every bundle. After editing a rule, run `npm run playbook`: it validates the files and rebuilds the compiled rules, the generated section of `skills/map-sources/SKILL.md` and `playbook/rules-overview.html`. `npm run build` runs the same check first and stops if anything is invalid or out of date. Each run stores the rules' content hash as `playbook_version`. `pipeline/tests/playbook/` holds snapshots taken before the rules moved: a change to a rule fails them on purpose. See [playbook/README.md](../../playbook/README.md).
