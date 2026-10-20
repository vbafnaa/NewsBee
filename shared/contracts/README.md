# Shared JSON contracts

Language-neutral snapshots of the edition, edition-listing, health and metrics formats.
`edition.schema.json` describes a full reader edition; `editions.schema.json` describes
the location listing. Keep these available to cloud apps and downstream consumers.

These schemas originated in the Python prototype. Its Pydantic definitions and former
generation instructions are retained under
[`archive/python/shared/contracts`](../../archive/python/shared/contracts/); that
generator is historical and is not a supported cloud development command. The cloud
runtime's types and validation live in the TypeScript apps.
