# Local prototype tests

| Folder | Coverage |
| --- | --- |
| `unit\` | Isolated backend modules and frontend components |
| `integration\` | Contracts and interactions across module and project boundaries |
| `end_to_end\` | Complete local source-to-edition, website, review, and email-preview workflows |
| `fixtures\` | Recorded or synthetic source inputs and expected outcomes for repeatable replay |

Mirror the relevant project and module names within each test category as tests
are implemented. Keep cross-component tests here rather than hiding them inside
one component. A test runner and fixture formats are not selected yet.

Prioritize integration coverage of orchestration and source-agent pipelines,
connector outputs and story processing, editorial checks and review, approved
edition assembly and publishing, API consumers, and local email previews.
Include explicit failure behavior, retries, restarts, and correction scenarios.

Use fixtures for repeatable offline runs; keep live-source and actual-model
checks explicit and separate from deterministic tests. Fixtures must not include
credentials, private reader data, or source material without permitted use.
Policy-dependent expected outcomes require confirmed rules.

The roadmap's proposed Stage 1 exit gate is two communities, two connector types,
and three simulated weekly cycles, with inspectable support, held risk cases,
restart recovery, and corrections. The scaffold does not implement or claim to
pass that gate.
