# Article generation and factual review

Newsbee turns source records and permitted article evidence into short reported articles. Evidence determines length: a short factual brief is preferable to a longer article with invented context. Article creation builds a preview; the existing channel publication flow remains separate.

## Writing and evidence review

1. Keep the selected primary source and preserve every contributing source link. Merge only compatible occurrences; different venues, dates, named places and incident identifiers are not interchangeable. A generic newsroom listing URL does not identify every story listed on that page.
2. Gather evidence through the existing readers and access checks. Extract facts with supporting source passages. The writer's enriched description is not allowed to independently authorize claims in the verification pass: that pass receives the original record, structured schedule and permitted fetched text.
3. Write a headline and reported prose. Preserve qualifications, source attribution and the distinction between a proposal, a recorded permit, an approval, a construction start and a completed project. Supply the edition's as-of date so expired deadlines are not described as currently open.
4. Apply deterministic checks for numbers and units, quotations, names, dates, source conflicts, requirements, unsupported completion, invented purpose, style and the existing content floor.
5. Review every headline and sentence in a separate model call using the same run-authorized runtime. Each unit must be supported, unsupported, contradicted or in unresolved conflict. Supported units need exact, validated source evidence. Missing units, duplicate IDs, fabricated evidence, incomplete responses and unanchored assertions fail verification.
6. Allow one bounded rewrite. Verification feedback describes the failed claims and supporting evidence. There are at most two generation calls and two verification calls per candidate; verification runs only after deterministic checks pass. Existing quota backoff remains active.
7. If generated prose still fails, a short exact-source brief may be used only when it passes the same factual, style and content-floor checks. Its title and each selected sentence must occur in the supplied source. Required reader conditions (registration and accommodation notice periods, and obituary death date and age where stated) must survive even in a brief. It cannot override an explicit source-date conflict or a source conflict identified by verification, including one from the first attempt. Generation errors remain held. Rejected generated text, including invented quantities, is never salvaged: a separate exact-source brief may replace it only after the brief itself passes all deterministic and content-floor checks. Rejected attempts remain in the audit result. Known source conflicts still block the fallback. An exact-source brief is labeled in the saved result.
8. Cache only passed, evidence-reviewed results. The policy version, evidence sources and as-of date contribute to cache identity. Old unverified cached prose is not silently reused.

## Editorial rules

- A recorded permit is not proof of approval, work commencement or property value. A project estimate must retain what it measures.
- Equivalent money formats such as $1,000,000 and $1 million are equivalent. Changing currency, percentage or magnitude is not equivalent.
- Stress-free, gluten-free or similar compounds do not establish free admission.
- A plan to secure a contractor does not establish an executed contract. A target construction window is not a guarantee, and being on track does not establish a recovery from an earlier delay.
- A no-school notice does not support an invented ceremony, venue, staff activity or regular class attendance.
- Conflicting event dates require clarification. The writer must not simply choose the date from the title. Event notices can arrive with a news classification, so explicit source conflicts are checked there too.
- Quotations must retain their actual wording and speaker. A source being named somewhere in an article is not proof that every claim is attributable to it.
- Sparse sources may yield one sentence. Avoid generic benefits, hype and padding. Complete proper names such as Genealogy Drop-In must not be rejected as dangling prepositions.

## Attribution

Saved article results include the original writing evidence and per-sentence verification references. Public editions carry structured publisher-and-URL source lists. The reader displays contributing source links in the article footer, while existing photo and illustration attribution remains separate. Tracking variants are deduplicated and unsafe links excluded.

A dataset URL is weaker reader-facing provenance than an individual record link. The source list does not itself establish a public sentence-by-sentence citation interface. Internal claim evidence remains available for audit.

## Operational boundaries

This implementation does not change API-key enforcement, credential fallback, provider selection, source-access rules, reuse restrictions, output-channel authorization, illustration selection or deployment settings. Verification uses the caller's already authorized model. No personal keys are replaced by deployment defaults. The local diagnostic tool uses an explicitly selected installed model, never an implicit production fallback.

Verification adds model calls and can increase holds when a model cannot follow the evidence schema. Semantic review by the same model is not independent human review and does not guarantee correctness. Deterministic checks remain necessary: the small-model evaluation missed a planned-versus-secured contract claim that a deterministic check correctly held.

## Evaluation and release checks

The saved local evaluation includes four real-source failure drafts and three explicitly assistant-edited grounded controls. The combined deterministic and semantic checks hold all four failure drafts. These small challenge samples are not a production accuracy estimate. Raw source/model audit snapshots are intentionally kept local and excluded from the release. The committed regression tests encode the relevant failure modes using minimal fixtures.

Before release, run article, model, publishing, illustration, reader, credential and source-access regressions; both type checks; and both production builds. Compare protected credential and access files directly with current main. Existing owners must resolve any Vercel deployment block using their normal release process; do not alter access settings or account identity to work around it.


## Local ten-category review

`/article-review` is an authenticated, local-development-only, read-only view of
`.local/article-review/report.json` under `NEWSBEE_ROOT`. It displays sourced writer
samples, important reader conditions, publication/event metadata, merge groups,
held reasons and source links. It is not a current edition or a publishing route.
The page is unavailable on Vercel and in production. No credentials or access policy
are changed by this review.

From `apps/journalist-site`, run:

```sh
node scripts/review-category-articles.mjs INPUT.json OUTPUT.json mistral:latest
```

The runner uses only the installed loopback Ollama model and the real writer,
claim verifier and merge grouping. It never publishes or writes pipeline runs.
Use `--resume --only=events,schools` to repeat selected samples while preserving
prior attempts. Input records must have real source URLs and source captures;
label historical snapshots, regional examples and selected excerpts explicitly.
This review does not prove live collection, publication, or editorial readiness.

A directly cited article can identify closely related news coverage across
publication dates within 14 days, with shared topic terms and compatible status.
Generic homepages, different episodes and event times do not qualify. Assembly
retains the primary occurrence; differing news publication dates do not themselves
constitute conflicting event times. Unresolved factual disagreements still require
the existing evidence review.
