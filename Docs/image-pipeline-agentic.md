# Agentic photo editor

The base photo editor was pushed on `nkd/image_pipeline_integration` at `4df721d`.
The scoped photo-catalog additions are documented in
[permissions and testing](photo-catalog-testing.md). No production deployment was made
for this work. Mocked-model tests verify the controls, not real-model editorial accuracy;
live metadata and decoding checks do not substitute for story-specific visual approval.

## Enable and compare

Choose **Photos: Agentic** or **Compare** in the kick-off panel. Current/agentic discovery
flows both support the photo editor; autopilot/manual publication behavior is preserved.
The photo call limit defaults to 40 reservations per edition. For hosted models, explicitly
tick **Agent model** with its existing shared budget and configure a capable provider.

| Provider | Image-input configuration |
| --- | --- |
| Gemini | Existing configured Gemini provider supports image inputs; `NEWSBEE_GEMINI_VISION=false` disables them. |
| OpenAI-compatible | Set `NEWSBEE_LLM_<PROVIDER>_VISION=true` only for a model confirmed to support image inputs. Existing provider key/model settings still apply. |
| Local Ollama | Select an installed vision-capable model and set `NEWSBEE_OLLAMA_VISION=true`. No models are downloaded automatically. |

For local review without API fees, install `qwen3-vl:2b-instruct` with Ollama and use:

```env
NEWSBEE_MODEL_PROVIDERS=ollama
NEWSBEE_OLLAMA_MODEL=qwen3-vl:2b-instruct
NEWSBEE_OLLAMA_VISION=true
NEWSBEE_PAID_ALLOW=
NEWSBEE_PAID_BUDGETS=
```

Use the instruction-tuned tag explicitly; the bare `2b` tag selects a thinking model.
Keep paid services unchecked in the run options. This provider list has no hosted
fallback. CPU inference has a four-minute request timeout and ten-minute story deadline;
the same call caps, visual standards and publishing checks still apply.
Local review uses 640-pixel overview previews and an unscaled 512-pixel detail crop.
Originals, minimum usable resolution and published derivatives retain their full size.
Exact venue/street queries are planned from source evidence with rules in local mode;
model calls compare available photo pixels, propose refinements after visual rejection,
and critique crops. Empty searches do not spend local inference on query rewrites.
Local passes review one usable candidate at a time to fit CPU memory and latency.
The critic receives one labeled contact sheet containing desktop/mobile overviews and
the unscaled 512-pixel native detail. This changes model input, not delivered resolution.

`NEWSBEE_IMAGE_MODE=current|shadow|agentic` controls the default for new runs (agentic).
`NEWSBEE_IMAGE_CALL_BUDGET` controls the edition photo call cap (40 by default, maximum
200). Older saved runs with no photo-mode field retain current behavior. No capable or
permitted model means text-only output in agentic mode. Use Compare for real-model
evaluation before choosing agent-selected photos for production.

The objective is to select a real photograph that helps a reader understand the story.
Photo coverage alone is not a success measure. A beautiful but irrelevant image fails.
The agent must explain what the photograph adds and what it cannot establish.
Reviews receive the source description, published schedule, reported venues and candidate
place/caption. An organizer's name or default address cannot establish a class or event's
physical venue; conflicting site or branch evidence must lead to rejection. The local
mime-class correction is documented in [the current-state report](image-pipeline-state.md).
The same checks apply to every story and every image provider. A shared metadata guard
runs before downloads, attachment, publication and reader delivery. It rejects incompatible
roles, unsupported places and conflicting explicit venue evidence, including branch names
that differ from an organizer's default venue. The guard uses supplied evidence; it does
not infer unrecorded geography or identify people from photographs.

Under `photo_editor_v4`, both visual review and the independent critic must confirm
`subject_matches`, `place_matches`, `time_matches` and `evidence_consistent`, with a written
explanation. Missing, malformed or negative relationship assessments fail even with perfect
quality scores. Publication checks hashes of the reviewed story and exact photo metadata;
older approvals or changes to the role, caption or place cannot reuse that approval.
Current mode retains deterministic metadata checks and does not claim pixel review.

## Implementation map

- `pipeline/images/editor.ts` plans bounded searches, reviews pixels, compares candidates,
  retries using rejection evidence, and runs a separate critic on desktop/mobile crops.
- `pipeline/images/quality.ts` uses Sharp to fully decode, orient and crop originals,
  enforce editorial resolution, and create WebP derivatives without enlargement.
  The final critic also receives a 512-pixel native-detail sample to assess sharpness
  and compression without relying solely on downscaled layout previews.
- `ModelRuntime.generateVisionStructured` supports inline image data on Gemini,
  OpenAI-compatible and capable Ollama providers, including fallback and usage recording.
- MongoDB stores `photo_assets`, `photo_assets_blobs` and `photo_assets_originals`.
  Published JSON carries `image_asset_id`; the edition-scoped endpoint serves reviewed
  variants without requiring a live origin. Reader photo rejection still withdraws access.
- `image_agent_states`, `photo_model_reviews`, `story_image_shadow_results`, `api_calls`
  and `run_decisions` preserve plans, queries, judgments, rejection reasons and cost traces.

## One photo editor, with a final critic

Use one orchestrator that calls bounded tools, persists its decisions, and chooses its
next action from the previous result. Give the final candidate to a separate critic
prompt with the original story, provenance and proposed crop. These are application
roles, not a requirement to provision multiple models or autonomous processes.

Every tool validates its input and output. A model's positive judgment cannot override
an absent license, wrong location, expired approval, insufficient pixels, or exhausted
budget. Tool-level checks matter because agent-level guardrails do not automatically
surround every call. See the [official OpenAI guardrails guidance](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals).

| Stage | Agent work | Required check before continuing |
| --- | --- | --- |
| 1. Visual brief | Explain what an image could add; identify subject, place, story date, acceptable context and intended display size. | Census/police/court context exclusions remain rules. Permits may use the named street; an event may use its venue. A context image cannot claim to depict the reported occurrence. |
| 2. Search plan | Choose approved providers, exact names, aliases, addresses and query order. | Requests stay inside approved access paths and enabled services. Search results and page instructions are untrusted data. |
| 3. Candidate acquisition | Collect images, original source pages, photographer, license evidence, capture date and available sizes. | A tool verifies the evidence and source identity. The agent cannot grant reuse permission or infer a capture date from upload time. |
| 4. File and resolution review | Request a larger permitted original when a thumbnail is inadequate. | Decode the actual downloaded file; verify dimensions, orientation, size, format and usable pixels after cropping. Reject broken files and undersized images before model calls. |
| 5. Visual editorial review | Inspect image pixels beside the story and evidence. Assess subject relevance, usefulness, visible quality, composition, distracting text/watermarks and misleading implications. | Structured findings must reference candidate IDs and distinguish observations from source claims. Unknown identity/date/place is not a verified match. |
| 6. Refine or use secondary stock | Change the query based on concrete rejection reasons. Try stock only once primary sources are exhausted. | Fixed search/call/time budgets; no repeated identical failed search. Stock remains restricted to suitable neutral event activities and visibly labeled. |
| 7. Select and critique | Compare qualified candidates, explain the winner, and inspect the proposed desktop/mobile crops. | A separate critic accepts, rejects, or requests another search. An unrelated image cannot win on aesthetics. No crop may remove essential context or imply different facts. |
| 8. Prepare and publish | Save the approved asset and derivatives, create factual alt text and a short credit, then attach. | Recheck rights, freshness, story revision, asset hash and review version. Test image delivery and crop at each display size. Otherwise publish text-only. |

The loop is: plan -> discover -> check -> inspect -> compare -> refine, until a candidate
passes or the available sources/budget are exhausted. Each retry states what new
evidence or search strategy it expects to obtain.

## Quality defaults

These are product defaults to calibrate on representative photos, not model capability
claims or established universal thresholds.

| Use | Usable pixels after the selected crop | Delivery |
| --- | --- | --- |
| Story card or list photo | At least 1,200 pixels wide and 600 pixels tall | Generate appropriately sized variants; never enlarge a small source to pass. |
| Lead or full article photo | At least 1,800 pixels wide and 900 pixels tall; prefer 2,400+ wide | Serve a responsive variant while retaining a rights-approved original. |
| Portrait orientation | Must retain useful content in the supported 3:2 desktop and 4:3 mobile crops | Reject unsuitable crops; a dedicated portrait slot is a future extension. |

Relevance, editorial value and quality are independent gates. A starting review rubric
can rate each from 0 to 5, with acceptance requiring at least 4 in every category and no
unresolved misleading-context flag. Calibrate these thresholds against human judgments;
model self-reported confidence is not a measured probability. Sharpness/compression
metrics are supporting evidence, not standalone truth: a clear sky can have low texture.

Model review does not prove authenticity or detect every manipulation. Ground place,
photographer, capture date and any named person in source evidence. Do not identify people
from their faces or manufacture a scene that the story does not establish. Supply
metadata explicitly alongside the pixels. Vision models can produce incorrect
descriptions and do not read original file metadata automatically; image preprocessing
can also resize inputs. See the [official images and vision guidance](https://developers.openai.com/api/docs/guides/images-vision).

## Evidence saved for each decision

Persist the story hash, candidate ID, source URL, original-image hash, pixel dimensions,
capture-date evidence, photographer, license evidence and check times. Add the visual
brief, queries tried, per-stage accept/reject reasons, visual observations, relevance /
utility / quality findings, critic outcome, crop coordinates and derivative hashes.

Record model/provider and prompt/policy versions, actual token/call costs, cache hits,
budget remaining, and whether a human or model performed visual review. The normal
pipeline funnel should expose a concise outcome and link to the full image trace.
An output schema is a shape guarantee; separate code must verify the factual claims
and policy conditions in it.

Cache visual review by original-image hash + story hash + crop + policy/model version.
A story rewrite, changed image, changed crop or new policy invalidates the relevant
review. Freshness and rights are rechecked even when visual review comes from cache.

## Bounded autonomy and cost

There are at most two primary search rounds and one separate stock round, with twelve
metadata candidates per query. Primary and stock share a maximum of six downloads,
four model-call reservations and a 180-second deadline per story (600 seconds for local
Ollama). Each model request has a 25-second timeout (240 seconds for local Ollama),
limited further by the story's remaining time.
The edition photo call cap and existing hosted-agent call cap
both apply. Failed reservations count; cached responses do not. Provider fallback attempts
also consume the shared paid-service allowance. Every image in a batch has its own review.
When metadata/file checks leave no visual candidates, the planner can revise its query
from the actual rejection reasons. Visual review can propose its next query in the same
response. These refinements share the same four-call cap; they do not create extra budget.
Actual monetary cost is reported when provider pricing is configured; this is not a new
dollar-denominated spending limit.

Route hosted vision work through the existing `agent_model` permission and cost gateway.
Use a provider only after verifying its image-input capability; a text-only fallback
cannot claim to have inspected pixels. All paid services remain off unless selected.
Use the chosen provider's actual image-token usage to account for cost; do not assume
that a particular detail label always costs less across models.

With vision disabled or unavailable, agentic mode records `visual_review_unavailable`
and leaves the story text-only unless a still-valid completed review can be reused.
A general reader-submission approval is not treated as a hash-bound visual quality
review. Metadata-only processing is never labeled visual vetting. A photo failure never
blocks valid news text.

Autopilot proceeds after image work settles. Manual mode retains its existing stage
controls. Sensitive or uncertain candidates can be omitted or surfaced to the editor
without creating a mandatory human step for every ordinary photo.

## Delivered workflow and evaluation

1. A provider-neutral image-input method and capability flag on `ModelRuntime`, with
   provider adapters and existing paid/usage instrumentation. Select a verified capable
   configured model; no model migration is needed merely to orchestrate the workflow.
2. Real image decoding and editorial resolution rules. Commons requests 2,560-pixel
   variants and may use the original file when a thumbnail cannot meet the selected slot.
3. Visual-brief, candidate-review and critic schemas/prompts, with strict runtime
   validation and the evidence constraints above.
4. Persisted, bounded search rounds with targeted retry reasons and
   a separately budgeted stock pass after primary sources are exhausted.
5. Immutable asset storage and crop/resize derivatives, plus `srcset`/`sizes` delivery.
   Preserve source/credit/license links and keep reader-photo withdrawal authoritative.
6. Photo mode, quality requirements and call caps in the existing kick-off UI; plans,
   rejection reasons and shadow outcomes appear in the story trace.
   Keep all work on the shared current/agentic authoring path; the image agent is a
   separately configurable capability, not an accidental consequence of flow selection.
7. Next operational step: extend the two-photo local evaluation with a representative,
   human-reviewed Compare dataset before production rollout. Existing rule-based
   publication can remain the comparison baseline.

## Acceptance and evaluation

Use a human-reviewed dataset across all four communities: correct venue, same-name venue
in the wrong city, neighboring street with a different ordinal/direction, relevant but
blurry photo, sharp but irrelevant photo, logo/thumbnail, unknown license, stale capture
with a recent upload, watermark, misleading crop, census/police exclusions, reader-photo
withdrawal, budget exhaustion and a story rewritten after review.

Measure hard-rule violations, editorial acceptance rate, whether the image adds useful
information, harmful/misleading selections, unnecessary stock, duplicate images,
unhelpful blank space, delivered pixels/crop quality, latency and cost per approved image.
Hard-rule violations must be zero in the regression suite. Track image coverage as a
secondary metric so the agent is not rewarded for filling every slot. Use saved traces
to compare versions and find regressions, following the [official agent evaluation guidance](https://developers.openai.com/api/docs/guides/agent-evals).

Example: a park gathering may benefit from a clear recent park view. The permit at NW
90th Street may benefit from a verified view of that actual street, but the image cannot
claim to show the pergola or construction progress. Neither story benefits from an
attractive photograph of the wrong location.
