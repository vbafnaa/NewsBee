# Cross-project contracts

Home for versioned data contracts exchanged by the backend, reader website,
and review console. Examples of future contract areas are published editions,
stories with attribution, and review requests.

`health.py` contains authoritative Pydantic definitions for the infrastructure
health and empty editions responses. The adjacent `*.schema.json` files are
generated for language-neutral consumers, not hand-maintained copies.
Regenerate them with `uv run --locked python scripts/dev.py contracts`;
integration tests detect schema drift.

Backend-only module interfaces belong in
`projects\backend\shared\contracts\`. HTTP-specific request and response concerns
belong in `projects\backend\api\schemas\`. This folder is not a general-purpose
shared code or UI library.
