# Pipeline quality evaluation — Shruthika

## Scope and ownership

Pipeline 2 article generation, source evidence and ranking are Shruthika's implementation focus. Sahanaa's Stage 1 architecture and Mitali's workspace/publish workflow remain the baseline. Coordinate the Stage 1 service split with Vedica before starting provider comparisons. The linked Claude artifact was inaccessible during this review; the current repository is the implementation source of truth.

This change adds deterministic checks for unsupported numeric quantities and calendar words in stories, edition fronts and email previews, isolates relaxed-access evidence caches, and makes ranking diversity use source identity rather than connector type. All web publishers previously incurred the same-source similarity penalty, even when they were independent sources. Existing publication approval remains separate from edition creation.

## Automated validation

From the repository root:

```sh
npm --prefix apps/journalist-site ci
npm --prefix apps/reader-site ci
npm --prefix apps/journalist-site run lint
npm --prefix apps/journalist-site test -- --maxWorkers=4
npm --prefix apps/journalist-site run build
```

The suite uses local MongoDB instances and fake models. Evidence integration cases cover source retrieval, rights restrictions, private-address rejection, extraction provenance, ranking inputs, model failure, quota backoff, article holds and cache isolation. New writer cases label invented ages, counts, currency, percentages and magnitudes as held; equivalent numeric formatting is allowed. Ranking cases check independent publishers and malformed model order IDs. These are fixture results, not live provider benchmarks.

## Stage 1 comparison matrix — not yet run

Use **Location workspace → Sources**, not the read-only internal maps. Use Wedgwood and Moses Lake, the same location boundaries and source-review policy, isolated runs, the same model and budgets. Record exact settings and run IDs; repeat each assigned configuration three times to distinguish service effects from model variation. Run one-variable comparisons before combining winners.

| Configuration | Change from agentic baseline | Owner | Status |
| --- | --- | --- | --- |
| Fixed-flow control | Current source flow | Coordinate with Vedica | Not run |
| Agentic baseline | Default agent tools, respect access, model check enabled | Coordinate with Vedica | Not run |
| Search provider comparison | Change only the selected search provider | Coordinate with Vedica | Not run |
| Tavily ablation | Toggle Tavily only | Coordinate with Vedica | Not run |
| Exa ablation | Toggle Exa only | Coordinate with Vedica | Not run |
| Retrieval comparison | Toggle an available rendered-page reader only | Coordinate with Vedica | Not run |
| Combined candidate | Combine independently useful services within the agreed budget | Coordinate with Vedica | Not run |

Do not assume every service is available in every flow: record the actual run options and whether a service was invoked. A service enabled but unused is not evidence that it improves or harms coverage. Add personal keys in API settings. Failed, rate-limited and budget-exhausted runs must remain separately labeled, not counted as zero-yield successes.

For each run record location, run ID, commit, model, selected services, actual calls, budgets, elapsed time, completion state, unique URLs, accepted/rejected/unreviewed counts, rejection reasons and category coverage. Label sources Accept or Reject with the evidence-based reason in the workspace; leave uncertainty unreviewed. Useful-source precision is accepted / (accepted + rejected); report review coverage separately. Report unique useful sources and incremental accepted URLs over baseline. Call it recall only when an independently reviewed reference set exists. Use existing `scripts/score-sources.mjs` for reference-list comparison.

## Pipeline 2 live evaluation — not yet run

1. Use a dedicated test location/workspace with the same accepted source snapshot for both configurations; capture its source IDs and review labels. Do not clear production caches or overwrite reader editions.
2. Create an edition using the baseline commit, then another with this change, holding the time window and options fixed. Preserve run IDs, source snapshots, model/provider and costs. Repeat if comparing ranking quality statistically.
3. In the edition funnel inspect collected items, locality rejections, deduplicated stories, ranking explanations, evidence URLs/passages, extracted facts and held drafts. Review all top-five stories per section and a sample of discarded candidates.
4. For each candidate label: local/relevant, original/supporting source, current within window, duplicate, actionable, and source-supported. For each article record pass/revise/hold and the precise unsupported claim, quote, number, date or attribution. Keep evidence URLs and excerpts with the label.
5. Measure source relevance among reviewed candidates, useful-story precision at five per section, duplicate rate, source diversity, unsupported-claim rate among reviewed drafts, held-draft reasons, missing evidence, generation time and model cost. Compare the same candidates where possible; a smaller edition is not automatically a regression if unsupported drafts were correctly held.
6. Confirm creating an edition ends at **Ready to publish** and leaves the reader's live edition unchanged. Inspect the preview and source links. Publish only an editorially reviewed edition through the existing Publish step.

Suggested label row: `run_id, story_id, source_url, section, rank, local, current, duplicate, actionable, factuality_label, reason, reviewer, reviewed_at`.

## Limits and follow-up

Numeric validation is lexical. It normalizes commas and decimal trailing zeroes and preserves currency, percentage and thousand/million/billion markers. It does not prove that a supported number belongs to the right person, date, unit or event, nor detect every spelled-out quantity. Calendar-word checks do not prove that a weekday/date pair is correct. Quotes, proposal-versus-approval distinctions and all other semantic claims still require editorial review. Conservative holds may require rewriting with the source's numeric formatting or units.

Ranking now distinguishes saved source IDs; multiple feeds from one publisher can still have distinct IDs. No claim is made that this optimizes editorial ranking without human comparisons.

A separate worktree is local code isolation, not a staging deployment. No new staging environment, live service benchmark, subscriber publication or video/YouTube action is performed by these code changes. Production deployment status must be checked separately after the main push. Roll back via a revert commit if needed; no schema migration is required.

## Results from this change (November 8, 2026 Pacific)

- Automated suite: **784 passed, 2 opt-in live tests skipped** across 66 files (64 passed, 2 skipped).
- Journalist TypeScript check and production build: passed. Reader Astro check: 44 files, zero errors/warnings/hints; reader production build: passed.
- Validation ran on local Node 25.6.1 / npm 11.9.0; the reader deployment targets Node 24. The reader build warned about the local version and completed. Production runtime verification remains separate.
- Existing test setup logged Census directory HTTP 404s; the suite passed despite those fallback-path messages. This does not establish Census availability.
- A separate opt-in live reader audit used the archived independent Wedgwood map and the existing harness's **November 6, 2026 reference date**. It made real public-source reads, but did not run full orchestration, locality, article generation or publication. This is not a fresh Stage 1 comparison.

The first two readers retrieved six dated items in total; that is **not six distinct publishable stories**. The following are provisional audit labels, not saved production source decisions:

| Item | Retrieved source | Audit label | Reason |
| --- | --- | --- | --- |
| Enrollment Info Session, Nov 19 | Wedgwood Elementary calendar | Review locality/window | District-wide enrollment session at Viewlands Elementary; assess relevance and target edition window |
| No School Veterans Day, Nov 11 | Wedgwood Elementary calendar | Relevant district notice | School closure applies locally; retain once |
| No School Veterans Day, Nov 11 | Seattle Public Schools district calendar | Duplicate | Same closure as the school-calendar item; merge before writing |
| Family Story Time, Nov 10 | SPL Northeast Branch | Relevant local event | Explicit branch venue and date |
| Genealogy Drop-In, Nov 12 | SPL Northeast Branch | Relevant local event | Explicit branch venue and date |
| Family Story Time, Nov 17 | SPL Northeast Branch | Review window/recurrence | A second occurrence, not a second distinct program; apply edition/event-repeat rules |

The library reader also skipped two entries without venues. Community reporting yielded no reports: three community-feed links failed recent substantive local-report checks and one external page could not be read under robots policy. These are recorded gaps, not a claim that the community has no news. Inspect the rejected original pages before changing relevance thresholds.

The read-only live audit completed in 48.43 seconds. Its harness passed because it records outcomes rather than asserting external availability. **GDELT failed all three topic requests** (`news`, `safety and civic`, `business and community`) with `fetch failed` and returned zero events. This is an availability failure, not a valid zero-news result. Recheck provider connectivity before using it in comparisons. No live model article-quality benchmark was performed.
