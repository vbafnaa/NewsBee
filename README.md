# Newsbee
CSE589 UW Entrepreneurship Prototyping

## Stage 1: local prototype

This repository currently contains a structure-only scaffold for the all-local
prototype. No applications are runnable yet. Technology choices, dependencies,
and setup/run commands will be confirmed before runnable scaffolding is added.
Stage 1 will use local processing, storage, model inference, website and email
previews, and internal review; it does not include cloud deployment or production
email delivery.

## Repository map

```text
projects\
  backend\
    api\                    HTTP routes, schemas, and request-scoped wiring
      routes\
      schemas\
      dependencies\
    modules\                Pipeline and publishing capabilities
      orchestration\
      source_connectors\
        pipelines\          Source-agent fetch/extract/evidence workflows
        connectors\         Replaceable source-specific scraping logic
      story_processing\
      communities\
      editorial\
        planning\
        writing\
        publication_checks\
        review\
        edition_assembly\
        corrections\
      publishing\
      email_previews\
      ad_placements\
    shared\                 Backend contracts and infrastructure adapters
      configuration\
      contracts\            Backend-only interfaces and data types
      storage\
      model_inference\
      observability\        Instrumentation code
  website\                  Minimal local reader website
  review-console\           Minimal local editorial review interface
shared\
  contracts\                Data contracts exchanged between projects
config\
  local\                    Local environment configuration templates
  communities\              Community definitions
  sources\                  Onboarded-source definitions
  editorial_policies\       Versioned editorial policy configuration
observability\              Local health views and telemetry configuration
tests\
  unit\                     Isolated component tests
  integration\              Tests across component boundaries
  end_to_end\               Complete local workflow tests
  fixtures\                 Recorded and synthetic test inputs
scripts\                    Local setup, run, and maintenance commands
Docs\                       Existing product spec, roadmap, and diagrams
```

Start with the [backend map](projects/backend/README.md) for module ownership and
the [testing map](tests/README.md) for cross-component coverage. Empty directories
use `.gitkeep` placeholders so they survive a clone; these are not implementations.

## Design references

- [Product design spec](Docs/newsbee-design-spec-v1.html)
- [Implementation roadmap](Docs/newsbee-implementation-roadmap-v1.html)
