# Repository development rules

These rules apply to all development in this repository.

## Modular structure

- Organize components in a clear, deliberate file structure.
- Keep components independently replaceable and updatable, with clear responsibilities and interfaces.

## Testing

- Implement robust automated testing alongside product changes.
- Prioritize integration tests that verify how components interact, not only isolated component tests.

## Observability

- Treat metrics and logging as priorities from the start.
- Make product health easy to evaluate at a glance.
- Ask for clarification before choosing health indicators or how they will be presented.

## Stage 1: local development

- Get the entire stack working locally in stage 1 of the implementation plan.
- Keep setup minimal and easy for teammates cloning the repository.
- Provide concise, clear setup and run instructions in the README.

## Frontend scope

- Keep frontend components minimal and lightweight during initial prototyping.
- Defer detailed UX flows and visual design to a future iteration when the product owner supplies them.

## Clarification before implementation

- Always ask clarifying questions before implementing product behavior.
- Do not make assumptions about how the product should work.
- When requirements are ambiguous or incomplete, ask the product owner and obtain clarification before proceeding with the affected work.
