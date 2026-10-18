# Local API layer

This is the HTTP entry point for the single local backend, not a separate service.

| Folder | Responsibility |
| --- | --- |
| `routes\` | Thin endpoints grouped by capability that call the owning backend module |
| `schemas\` | HTTP request and response models |
| `dependencies\` | Request-scoped wiring, such as storage and module access |

Validate incoming requests, delegate work, and translate results into explicit
HTTP responses. Scraping, orchestration, editorial rules, and publishing logic
stay in `modules\` so scheduled and manual jobs can reuse them without HTTP.

Transport schemas belong here; shared business interfaces belong in
`backend\shared\contracts\`. Data exchanged with other projects is defined in the
repository's `shared\contracts\`. Avoid independently duplicating these contracts.
Routes, schema formats, and API versioning have not been selected yet.
