# Local prototype tests

| Folder | Coverage |
| --- | --- |
| `unit\` | Isolated backend modules and frontend components |
| `integration\` | Contracts and interactions across module and project boundaries |
| `end_to_end\` | Complete local source-to-edition, website, review, and email-preview workflows |
| `fixtures\` | Recorded or synthetic source inputs and expected outcomes for repeatable replay |

Mirror the relevant project and module names within each test category as tests
are implemented. Keep cross-component tests here rather than hiding them inside
one component. pytest runs only `critical` offline checks by default: acquisition,
publication safety, reader API/contracts, restart/retry behavior and email-preview delivery.
The broader regression tests are retained, not deleted, and run explicitly with
`python scripts/dev.py test-all`. This keeps the routine POC loop focused without losing
connector/parser edge cases when those modules change.
pytest-playwright exercises the review page and reader-to-API boundary using
isolated test servers. Commands and prerequisites are in the root README.

Prioritize integration coverage of orchestration and source-agent pipelines,
connector outputs and story processing, editorial checks and review, approved
edition assembly and publishing, API consumers, and local email previews.
Include explicit failure behavior, retries, restarts, and correction scenarios.

Use fixtures for repeatable offline runs; keep live-source and actual-model
checks explicit and separate from deterministic tests. Fixtures must not include
credentials, private reader data, or source material without permitted use.
Policy-dependent expected outcomes require confirmed rules.

`python scripts/dev.py replay` runs `integration/test_stage_one.py` and saves a JUnit report
to `.local/stage-one-replay.xml`. The gate traverses library RSS and Legistar connectors,
snapshots and authoring for two distinct communities over three simulated weekly cycles
(six editions), with inspectable evidence and idempotent retries. Companion checks cover
seeded sensitive/missing-support holds, correction visibility and suppression, recovery
after interrupted writing, and cache invalidation when source text or policy changes.

Only inference and external source responses are mocked. This proves deterministic pipeline
behavior, not model factuality, source permissions or useful live community coverage.
The remaining Stage 1 exit criteria are in the [roadmap](../Docs/newsbee-implementation-roadmap-v1.html).

`python scripts/dev.py browser` runs three critical reader checks: location selection,
source/coverage display and mobile rendering with corrections; no locations; and failure/retry.
Run `python -m pytest -m browser` explicitly for the full console/browser regression suite.
