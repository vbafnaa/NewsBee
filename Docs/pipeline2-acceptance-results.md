# Pipeline 2 acceptance results — November 8, 2026 Pacific

## Outcome

The implementation now has an automated collection → source review → deduplication → ranking → evidence-backed writing → edition-preview acceptance test. The final regression suite passed **807 tests**, with three explicitly opt-in live tests skipped. The journalist production build and TypeScript validation passed. The real local-model evaluation was run separately with two installed models; completing that harness is not the same as approving every draft.

No production database was changed and no newsletter was published. Main deployment was previously reported blocked by Vercel; its diagnostic page requires sign-in and the CLI has no credentials. Hosted-model evaluation and paid Stage 1 service comparisons remain unverified.

## What changed and why

- **Source status is checked again at assembly.** Items already collected from a source subsequently rejected or paused are dropped with a `source_review` reason. Proposed sources remain excluded unless the run explicitly allows them through the existing agentic/test policy.
- **The selected primary source stays primary.** Collapsing a merged story previously replaced its description with the longest copy and could use an earlier secondary URL. It now preserves the selected lead's title, description, facts and source URL while keeping the other occurrences as provenance.
- **Duplicate source copies are not recurring events.** Identical date/time/venue records count once in model ranking and the reader's schedule line. Distinct scheduled sessions remain distinct. Original source occurrences are retained.
- **Reported prose replaces promotional instructions.** Lively/bold modes still use readable, direct prose, but no longer demand a clever hook, drama or a closing invitation. Sparse evidence can produce a short factual brief. The actual models' promotional outputs are regression cases.
- **Additional factual checks hold unsupported quotations, newly introduced capitalized names, inferred purposes, and asserted approval/completion without affirmative source support.** A proposal is not automatically an approval, and “construction has not started” cannot justify “construction started.” The existing one-retry policy remains bounded. Factual holds cannot be converted into passes by disabling quality selection.
- **Explicit event-date conflicts are held.** A title naming November 10 and an opening meeting statement naming November 7, or a contradictory parsed occurrence date, no longer silently passes pre-writing eligibility. This is a narrow check, not a general temporal reasoning engine.
- **Edition introductions and emails retain the exact writing evidence.** Fetched source facts used in the article remain available to front/email validation. The original feed snippet remains separately stored for provenance.

## Real local-model comparison

Inputs: three recorded public connector items (school closure, Family Story Time, Genealogy Drop-In) and three clearly synthetic fixtures (proposal, approved project, sparse meeting notice). Same source cases and deterministic runtime settings; no paid model calls. The model directly evaluates writing and base newsworthiness; it does not test production orchestration or subscriber delivery.

| Case | Qwen 2.5 Coder baseline, old policy | Qwen final policy | Llama 3.2 final policy |
| --- | --- | --- | --- |
| School closure | Passed despite promotional invented purpose | Held: unsupported Seattle name in supplied text | Held: invented names, decision, dates and purpose |
| Family Story Time | Passed promotional opening | Held: unsupported purpose wording | Passed automated checks |
| Genealogy Drop-In | Passed generic branch invitation | Held: promotional opening | Passed automated checks |
| Playground proposal (synthetic) | Passed | Passed | Passed |
| Playground approved (synthetic) | Passed | Passed | Passed |
| Sparse meeting (synthetic) | Passed invented community-building purpose | Passed concise brief | Held: invented Garden Club of Oakwood |

Final automatic pass counts: **Qwen 3/6; Llama 4/6**. The point of this exercise is that incorrect drafts are now held, not to maximize automatic pass rate. This tiny set does not prove general model superiority or factual correctness. Even passing drafts still require review for subtle semantic changes (for example, identifying a park's name as the council's jurisdiction).

The Qwen base-ranker placed the two civic fixtures first (14 each), then genealogy and the school closure (11), storytime (10), and the sparse notice (0). Llama placed the three recorded events first (13 each), the civic fixtures next (12), and the sparse notice last (0). These differences justify labeled ranking comparisons on real editions; they do not justify changing production model selection based on six cases. The acceptance test separately exercises the actual section-ranking integration, source provenance and final preview.

## Source-grounded edited examples

These examples were revised by the coding assistant from recorded source text and metadata. They are not claimed as unedited model output or as already published. Recheck source availability and the target edition window before publishing.

**Wedgwood Elementary observes Veterans Day closure**

Wedgwood Elementary lists Veterans Day as a no-school day. The school calendar points families to the district's school-year dates for the full schedule.

When: November 11, 2026. [School calendar source](https://wedgwoodes.seattleschools.org/events/veterans-day-no-school-3/). Duplicate district-calendar entry omitted.

**Family Story Time brings stories and songs to Northeast Branch**

Family Story Time at Northeast Branch includes stories, songs and learning activities for children ages 0–5 and their families. Families of all ages are welcome. The library lists the program as free, with no registration required.

When: November 10, 2026. [Library source](https://www.spl.org/event-calendar?trumbaEmbed=view%3Devent%26eventid%3D205891461). Northeast Branch is a nearby serving venue; this does not claim it is inside Wedgwood. Apply the repeat/window policy separately to the November 17 occurrence.

**Genealogy Drop-In offers one-on-one help at Northeast Branch**

The Seattle Genealogical Society offers free, one-on-one genealogy help at Northeast Branch. People with questions about their family-history research can get help at any experience level. Registration is not required.

When: November 12, 2026. [Library source](https://www.spl.org/event-calendar?trumbaEmbed=view%3Devent%26eventid%3D206692316).

## Reproduction and review

```sh
npm --prefix apps/journalist-site ci
npm --prefix apps/reader-site ci
npm --prefix apps/journalist-site test -- --maxWorkers=4
npm --prefix apps/journalist-site run build
cd apps/journalist-site
NEWSBEE_ARTICLE_EVAL=1 \
NEWSBEE_ARTICLE_EVAL_MODEL=qwen2.5-coder:latest \
NEWSBEE_ARTICLE_EVAL_OUTPUT=/tmp/newsbee-article-eval.json \
npm test -- pipeline/tests/model/article-quality-live.test.ts --maxWorkers=1
```

The opt-in evaluation requires an already-installed model and a local Ollama service. Set the model to `llama3.2:latest` for the second comparison. It makes no automatic model download and never publishes. Its JSON records source inputs, source type (recorded or synthetic), actual drafts, validation errors, attempts and ranking output.

For deployed review, open the location workspace, select accepted sources, create an edition, inspect the source links and held reasons, and preview the article text. Confirm it stays **Ready to publish** until the separate Publish action. Use the comparison/labeling protocol in [pipeline-quality-evaluation.md](pipeline-quality-evaluation.md).

## Limits and remaining release work

- Local validation used Node 25.6.1; the reader deployment targets Node 24. The earlier reader build passed with a local-version warning. Production runtime remains unverified.
- Name checks cover capitalized prose names, not every entity form or attribution. Numeric, date, purpose and action checks are conservative lexical checks; they cannot prove entailment, catch every invented fact or reconcile conflicting source accounts. More drafts may be held for review.
- Scheduled-occurrence matching uses exact normalized date/time/venue values. Different wording for the same time can still need deduplication review. Separate source IDs from one publisher are not yet a perfect publisher identity.
- The final suite includes Pipeline 1 discovery, agent, service-option, isolation and source-label regressions. Live paid-service combinations are not tested: local provider credentials are absent, and the teammate service split remains unconfirmed.
- The earlier read-only live source audit found working school/library extraction, an explicit GDELT failure and no accepted supplementary community reports. Those availability gaps remain visible; parser tests are not uptime evidence.
- Resolve the Vercel deployment block through an authenticated account, test the deployed configured model on labeled Wedgwood/Moses Lake editions, and have an editor approve the final reader edition. Do not describe this work as deployed or fully production-validated before those steps are complete.
